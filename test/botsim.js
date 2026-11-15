/* A table of bots only, dealt and played here by the server's own rules, with a seed: the same seed is the same deal,
   the same turns and the same result. test/botlevels.js plays its thousands of deals on it.

   The rules are the server's (server.js: setupGame, doDraw, doDiscard, doDrop, doDeclare, finishGame), and every move a
   bot makes is checked against them before it is played: a move the server would turn away is counted in `illegal`
   and the deal stops there. */
"use strict";
const eng = require("../server.js");
const Bots = eng.Bots || require("../bots.js")(eng);

function rngOf(seed) {   // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function shuffle(a, rnd) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/* One deal. levels: one level a seat. opts: { pool, turnCap, first, drops (false: no seat may drop) }.
   Returns { winner (seat or -1), turns, illegal: [text], points: [a seat], dropped: [bool a seat], took: [a seat], reshuffles }. */
function playDeal(levels, seed, opts = {}) {
  const rnd = rngOf(seed), botRnd = rngOf(seed ^ 0x5bd1e995);
  const n = levels.length;
  const deck = shuffle(eng.buildDeck(), rnd);
  const hands = levels.map(() => []);
  for (let k = 0; k < 13; k++) for (let i = 0; i < n; i++) hands[i].push(deck.pop());
  const wildCard = deck.pop();
  const wildRank = wildCard.s === "J" ? 1 : wildCard.r;
  let open = [deck.pop()], closed = deck;
  let turn = opts.first != null ? opts.first : Math.floor(rnd() * n);
  const mem = Bots.memory(n);
  const drew = new Array(n).fill(0), out = new Array(n).fill(false), dropPts = new Array(n).fill(0);
  const res = { winner: -1, turns: 0, illegal: [], points: new Array(n).fill(0), dropped: new Array(n).fill(false), took: new Array(n).fill(0), reshuffles: 0, first: turn, distAtStart: null };
  const cap = opts.turnCap || 600;
  const active = () => out.map((o, i) => (o ? -1 : i)).filter((i) => i >= 0);
  const nextSeat = (s) => { do { s = (s + 1) % n; } while (out[s]); return s; };
  const finish = (w) => {
    res.winner = w;
    for (let i = 0; i < n; i++) {
      if (i === w) res.points[i] = 0;
      else if (out[i]) res.points[i] = dropPts[i] || 80;
      else res.points[i] = eng.scoreHand(hands[i], Bots.groups(levels[i], hands[i], wildRank) || [], wildRank);
    }
    return res;
  };
  if (opts.probe) res.distAtStart = hands.map((h, i) => Bots._distance({ seat: i, wildRank, wildCard, open, mem }, h));
  while (res.turns < cap) {
    res.turns++;
    const seat = turn, lv = levels[seat], hand = hands[seat];
    const top = open[open.length - 1];
    const t = { seat, hand, wildRank, wildCard, top, open, pickedOpenId: null, mem, next: nextSeat(seat), firstTurn: !drew[seat], pool: !!opts.pool, poolLeft: opts.poolLeft == null ? 999 : opts.poolLeft, active: active().length, canDrop: opts.drops !== false, rnd: botRnd };
    let from = Bots.draw(lv, t);
    if (from === "drop") {
      if (out[seat]) { res.illegal.push(`seat ${seat} (${lv}) dropped twice`); return res; }
      out[seat] = true; res.dropped[seat] = true; dropPts[seat] = drew[seat] ? 40 : 20;
      const act = active();
      if (act.length === 1) return finish(act[0]);
      turn = nextSeat(seat);
      continue;
    }
    if (from !== "open" && from !== "closed") { res.illegal.push(`seat ${seat} (${lv}) drew from "${from}"`); return res; }
    if (from === "open") {
      if (!top || eng.isJoker(top, wildRank)) { res.illegal.push(`seat ${seat} (${lv}) took ${top ? "a joker" : "nothing"} from the face-up pile`); return res; }
      hand.push(open.pop()); t.pickedOpenId = top.id; res.took[seat]++;
      Bots.noteDraw(mem, seat, "open", top, null);
    } else {
      if (closed.length === 0 && open.length > 1) { const keep = open.pop(); closed = shuffle(open, rnd); open = [keep]; res.reshuffles++; }
      if (closed.length === 0) { res.illegal.push("no card left to draw"); return res; }
      hand.push(closed.pop());
      Bots.noteDraw(mem, seat, "closed", null, top);
    }
    drew[seat]++;
    t.top = open[open.length - 1]; t.open = open; t.firstTurn = false;
    const p = Bots.play(lv, t);
    if (p && p.declare) {
      const id = p.declare.id, kept = hand.filter((c) => c.id !== id);
      if (kept.length !== 13 || id === t.pickedOpenId) { res.illegal.push(`seat ${seat} (${lv}) declared with a card it may not throw`); return res; }
      const v = eng.validateDeclare(kept, p.declare.groups, wildRank);
      if (!v.valid) { res.illegal.push(`seat ${seat} (${lv}) declared wrongly: ${v.reason}`); return res; }
      hands[seat] = kept;
      return finish(seat);
    }
    const id = p && p.discard, idx = hand.findIndex((c) => c.id === id);
    if (idx < 0) { res.illegal.push(`seat ${seat} (${lv}) threw a card it does not hold`); return res; }
    if (id === t.pickedOpenId) { res.illegal.push(`seat ${seat} (${lv}) threw back the card it just took`); return res; }
    const [c] = hand.splice(idx, 1);
    open.push(c);
    Bots.noteDiscard(mem, seat, c);
    turn = nextSeat(seat);
  }
  return res;   // the cap: nobody finished
}

/* Many deals between two levels, seat about: deal k is played twice from the same cards, once with each level in each
   seat, so neither the cards nor the first turn favour a level. Returns the tally. */
function match(a, b, deals, seed0, opts = {}) {
  const tally = { deals: 0, wins: { [a]: 0, [b]: 0 }, unfinished: 0, illegal: [], points: { [a]: 0, [b]: 0 }, turns: 0, maxTurns: 0, drops: { [a]: 0, [b]: 0 }, took: { [a]: 0, [b]: 0 } };
  for (let k = 0; tally.deals < deals; k++) {
    for (const lv of [[a, b], [b, a]]) {
      if (tally.deals >= deals) break;
      const r = playDeal(lv, seed0 + k, opts);
      tally.deals++;
      tally.turns += r.turns; if (r.turns > tally.maxTurns) tally.maxTurns = r.turns;
      if (r.illegal.length) { tally.illegal.push(`deal ${seed0 + k} [${lv}]: ${r.illegal[0]}`); continue; }
      if (r.winner < 0) { tally.unfinished++; continue; }
      tally.wins[lv[r.winner]]++;
      for (let i = 0; i < 2; i++) { tally.points[lv[i]] += r.points[i]; if (r.dropped[i]) tally.drops[lv[i]]++; tally.took[lv[i]] += r.took[i]; }
    }
  }
  return tally;
}

module.exports = { playDeal, match, rngOf, Bots, eng };
