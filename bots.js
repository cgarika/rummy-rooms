/* The bots' three levels (2026-11-13): settings.botLevel = "easy" | "normal" | "sharp", the host's pick in the lobby.

   NORMAL is the bot as it has always played, move for move: it takes the face-up card when that lowers its deadwood,
   finishes the moment it can and throws the card that leaves the lowest deadwood (server.js: botWantsOpen,
   botFinishCard, botDiscardCard). Quick play and every seat a person left to the bot play at normal.

   EASY is a beginner. It plays normal's game with a beginner's slips: it misses some of the face-up cards normal
   would take, now and then it throws a card it could have built on (one of a pair, one of two neighbours), and it
   never finishes early: it needs a turn to see that its hand is done (the turn its hand comes together it throws the
   finish card as a plain discard, and declares on its next turn). It never drops. One thing it does not copy from
   normal: a hand that is all melds and still cannot be declared (four sets and no sequence) is a dead end normal
   never leaves; after a few turns stuck there easy goes looking for its sequences as sharp does.

   SHARP plays the real game:
     - it builds what a declare needs, in that order: a pure sequence first, then a second sequence, then the rest;
     - it weighs keeping pairs and open runs by the cards still to come: it remembers what was thrown (the face-up
       pile) and what each player took from it, so a pair whose cards are gone is worth nothing;
     - it does not feed the next player: it avoids a card that goes with what they took, and likes one they threw
       or left lying;
     - it takes the face-up card only for a real gain, never to swap one loose card for a smaller one;
     - it times its finish: it declares the moment it can, keeps its hand grouped so that a loss costs only the loose
       cards, and in a pool game it drops a hopeless hand on its first turn rather than pay for it.

   Nothing here is trusted with a rule: every move goes through the server's own draw, discard, drop and declare. */
"use strict";

const LEVELS = ["easy", "normal", "sharp"];
const level = (x) => (LEVELS.includes(x) ? x : "normal");

const EASY = { missTake: 0.5, slip: 0.3, stuck: 10 };
/* Sharp's weights, in tenths of a card: a loose card costs `card` and `pt` for each of its points. */
const W = {
  card: 10, pt: 0.3,
  draw: 1.2, drawCap: 4,          // a pair or two neighbours, by the cards still to come that complete it
  noPure: 22, pureOut: 2, pureCap: 4,   // no pure sequence yet, less by the cards that would make one
  noSeq: 12, seqOut: 1.2, seqCap: 5,    // a pure sequence but no second sequence
  bare: 4,                              // neither a pure sequence nor any other
  room: 8,                              // each card of room a missing sequence still lacks (melds to break)
  take: 6,                              // what the face-up card must gain to be taken
  danger: 3,                            // a card that goes with what the next player took
  /* The drop. Measured over 3,000 seeded deals at a table of four: a first hand this far from a declare (one in
     eight) wins one deal in twelve and pays about 50 points when it is played out; the first-turn drop costs 20. */
  dropAt: 130, dropSeats: 3,
};
const SUIT = { S: 0, H: 1, D: 2, C: 3 };

function popcount(x) { let c = 0; while (x) { x &= x - 1; c++; } return c; }

module.exports = function make(eng) {
  const { isJoker, cardPoints, botDiscardCard, botFinishCard, botWantsOpen, deadwood } = eng;

  /* ---------- what the table remembers (the server and the tests keep it the same way) ---------- */
  function memory(seats) {
    const each = () => Array.from({ length: seats }, () => []);
    return { took: each(), threw: each(), passed: each(), ready: new Array(seats).fill(false), stuck: new Array(seats).fill(0) };
  }
  function noteDraw(mem, seat, from, card, top) {
    if (!mem || !mem.took[seat]) return;
    if (from === "open") mem.took[seat].push(card);
    else if (top) { mem.passed[seat].push(top); if (mem.passed[seat].length > 8) mem.passed[seat].shift(); }
  }
  function noteDiscard(mem, seat, card) {
    if (!mem || !mem.took[seat]) return;
    const i = mem.took[seat].findIndex((c) => c.id === card.id);
    if (i >= 0) mem.took[seat].splice(i, 1);
    mem.threw[seat].push(card); if (mem.threw[seat].length > 10) mem.threw[seat].shift();
  }

  /* ---------- easy ---------- */
  /* The loose cards (outside the hand's best melds) that touch another card: one of a pair, one of two neighbours. */
  function usefulLoose(hand, wildRank, pickedOpenId) {
    const all = deadwood(hand, wildRank), out = [];
    for (const c of hand) {
      if (c.id === pickedOpenId || isJoker(c, wildRank)) continue;
      if (deadwood(hand.filter((x) => x.id !== c.id), wildRank) !== all - cardPoints(c, wildRank)) continue;   // it is melded
      const touches = hand.some((o) => o.id !== c.id && !isJoker(o, wildRank) &&
        ((o.r === c.r && o.s !== c.s) || (o.s === c.s && o.r !== c.r && (Math.abs(o.r - c.r) <= 2 || (c.r === 1 && o.r >= 12) || (o.r === 1 && c.r >= 12)))));
      if (touches) out.push(c);
    }
    return out;
  }
  /* A hand that is all melds and still no declare (four sets, or a fistful of jokers and no pure sequence): normal's
     rule sees nothing to gain there and throws whatever it draws, for ever. Easy does the same for EASY.stuck turns
     running; after that even a beginner sees what is missing, and for the rest of that deal it looks for its sequences
     as sharp does (it still never drops). So an easy bot cannot sit on such a hand without end. */
  const allMelded = (cards, wildRank) => deadwood(cards, wildRank) === 0;
  const isStuck = (t) => !!(t.mem && t.mem.stuck && t.mem.stuck[t.seat] >= EASY.stuck);
  function easyDraw(t) {
    if (isStuck(t)) return sharpDraw(t, true);
    if (!botWantsOpen(t.hand, t.top, t.wildRank)) return "closed";
    return t.rnd() < EASY.missTake ? "closed" : "open";
  }
  function easyPlay(t) {
    const win = botFinishCard(t.hand, t.wildRank, t.pickedOpenId);
    if (win && (!t.mem || t.mem.ready[t.seat])) return { declare: win };
    if (t.mem) t.mem.ready[t.seat] = !!win;
    if (win) return { discard: win.id };   // the finished thirteen stay; next turn it sees them
    let c = botDiscardCard(t.hand, t.wildRank, t.pickedOpenId);
    if (t.mem && t.mem.stuck) {   // the dead end above
      if (!isStuck(t)) t.mem.stuck[t.seat] = allMelded(t.hand.filter((x) => x.id !== c.id), t.wildRank) ? t.mem.stuck[t.seat] + 1 : 0;
      if (isStuck(t)) return sharpPlay(t);
    }
    if (t.rnd() < EASY.slip) {
      const u = usefulLoose(t.hand, t.wildRank, t.pickedOpenId);
      if (u.length) c = u[Math.min(u.length - 1, Math.floor(t.rnd() * u.length))];
    }
    return { discard: c.id };
  }

  /* ---------- sharp: the melds a hand can make ---------- */
  /* Every meld the cards can make: { mask (the cards), j (jokers it borrows), v (its worth), type 0 set | 1 sequence |
     2 pure sequence }. A wild-rank card may stand as itself in a pure sequence; it is then one of the meld's cards. */
  function candidates(cards, wildRank, cardW, ptW) {
    const n = cards.length;
    const jok = new Array(n), val = new Array(n);
    let nJ = 0, jokerBits = 0, total = 0;
    for (let i = 0; i < n; i++) {
      jok[i] = isJoker(cards[i], wildRank);
      if (jok[i]) { nJ++; jokerBits |= 1 << i; val[i] = 0; }
      else { val[i] = cardW + ptW * cardPoints(cards[i], wildRank); total += val[i]; }
    }
    const melds = [], seen = new Set();
    const add = (idxs, j, type) => {
      let mask = 0, v = 0;
      for (const i of idxs) { mask |= 1 << i; v += val[i]; }
      if (v === 0) return;
      const key = mask * 4 + j;
      if (seen.has(key)) return;
      seen.add(key);
      melds.push({ mask, j, v, type });
    };
    // sequences: one suit, a window of 3 to 5 ranks (the ace low or high), jokers in the holes
    const nat = [[], [], [], []], wild = [[], [], [], []];
    for (let i = 0; i < n; i++) {
      const c = cards[i], s = SUIT[c.s];
      if (s === undefined) continue;
      const to = jok[i] ? wild[s] : nat[s];
      (to[c.r] = to[c.r] || []).push(i);
      if (c.r === 1) (to[14] = to[14] || []).push(i);
    }
    const jMax = Math.min(nJ, 2);
    for (let s = 0; s < 4; s++) {
      const N = nat[s], Wd = wild[s];
      if (!N.length) continue;
      for (let len = 3; len <= 5; len++) for (let a = 1; a + len - 1 <= 14; a++) {
        for (let copy = 0; copy < 2; copy++) {
          const idxs = [], holes = [];
          let second = false;
          for (let r = a; r < a + len; r++) {
            const L = N[r];
            if (L && L.length) { if (copy === 1 && L.length > 1) { idxs.push(L[1]); second = true; } else idxs.push(L[0]); }
            else holes.push(r);
          }
          if (copy === 1 && !second) break;
          if (!idxs.length) break;
          if (!holes.length) add(idxs, 0, 2);
          else {
            if (holes.length <= jMax && (len === 3 || holes.length === 1)) add(idxs, holes.length, 1);
            if (copy === 0 && holes.every((r) => Wd[r] && Wd[r].length)) add(idxs.concat(holes.map((r) => Wd[r][0])), 0, 2);
          }
        }
      }
    }
    // sets: one rank, a suit once, 3 or 4 cards with the jokers
    const byRank = new Map();
    for (let i = 0; i < n; i++) if (!jok[i]) { const r = cards[i].r; if (!byRank.has(r)) byRank.set(r, []); byRank.get(r).push(i); }
    for (const list of byRank.values()) {
      const m = Math.min(list.length, 8);
      for (let sub = 1; sub < 1 << m; sub++) {
        const size = popcount(sub);
        if (size < 2 || size > 4) continue;
        const idxs = []; let suits = 0, ok = true;
        for (let k = 0; k < m; k++) if (sub & (1 << k)) { const b = 1 << SUIT[cards[list[k]].s]; if (suits & b) { ok = false; break; } suits |= b; idxs.push(list[k]); }
        if (!ok) continue;
        for (let j = Math.max(0, 3 - size); j <= Math.min(jMax, 4 - size); j++) add(idxs, j, 0);
      }
    }
    melds.sort((x, y) => y.v - x.v);
    return { cards, jok, val, nJ, jokerBits, total, melds };
  }

  /* The best collections of melds that share no card, one for each kind of hand:
     0 no sequence, 1 one sequence (not pure), 2 two or more (none pure), 3 a pure sequence alone, 4 a pure sequence and another. */
  function search(cd, exBit, picks) {
    const bestV = [-1, -1, -1, -1, -1], bestMask = [0, 0, 0, 0, 0], bestJ = [0, 0, 0, 0, 0], bestPick = picks ? [null, null, null, null, null] : null;
    const melds = cd.melds, jokerBits = cd.jokerBits, stack = [];
    let nodes = 0;
    const go = (k, mask, jFree, acc, pures, seqs) => {
      const cls = pures ? (seqs >= 2 ? 4 : 3) : (seqs > 2 ? 2 : seqs);
      if (acc > bestV[cls]) { bestV[cls] = acc; bestMask[cls] = mask; bestJ[cls] = jFree; if (picks) bestPick[cls] = stack.slice(); }
      if (++nodes > 4000) return;
      for (let i = k; i < melds.length; i++) {
        const m = melds[i];
        if (m.mask & (mask | exBit)) continue;
        const jf = jFree - m.j - (m.mask & jokerBits ? popcount(m.mask & jokerBits) : 0);
        if (jf < 0) continue;
        if (picks) stack.push(i);
        go(i + 1, mask | m.mask, jf, acc + m.v, pures + (m.type === 2 ? 1 : 0), seqs + (m.type ? 1 : 0));
        if (picks) stack.pop();
        if (nodes > 4000) return;
      }
    };
    go(0, 0, cd.nJ - (exBit & jokerBits ? 1 : 0), 0, 0, 0);
    return { bestV, bestMask, bestJ, bestPick };
  }

  /* How many of each card are still to come, as this seat knows it: not in its hand, not in the face-up pile, not
     taken from that pile by another player, not the wild card on the table. */
  function liveTable(t, hand, pile) {
    const seen = new Int8Array(64);
    let jokersSeen = 0;
    const see = (c) => {
      if (!c) return;
      if (isJoker(c, t.wildRank)) jokersSeen++;
      if (SUIT[c.s] !== undefined) seen[SUIT[c.s] * 16 + c.r]++;
    };
    hand.forEach(see); (pile || []).forEach(see); see(t.wildCard);
    if (t.mem) t.mem.took.forEach((list, s) => { if (s !== t.seat) list.forEach(see); });
    const live = (s, r) => { if (r === 14) r = 1; if (r < 1 || r > 13) return 0; return Math.max(0, 2 - seen[s * 16 + r]); };
    live.jokers = Math.max(0, 10 - jokersSeen);
    return live;
  }

  /* The pairs and neighbours among some of the cards: [{ a, b, outs, run }], the cards still to come that complete each. */
  function draws(cd, idxs, live) {
    const out = [], cards = cd.cards;
    for (let x = 0; x < idxs.length; x++) for (let y = x + 1; y < idxs.length; y++) {
      const a = cards[idxs[x]], b = cards[idxs[y]];
      let outs = 0, run = false;
      if (a.s === b.s) {
        if (a.r === b.r) continue;
        const s = SUIT[a.s], lo = Math.min(a.r, b.r), hi = Math.max(a.r, b.r);
        if (hi - lo === 1) outs = live(s, lo - 1) + live(s, hi + 1);
        else if (hi - lo === 2) outs = live(s, lo + 1);
        else if (lo === 1 && hi === 13) outs = live(s, 12);
        else if (lo === 1 && hi === 12) outs = live(s, 13);
        else continue;
        run = true;
      } else if (a.r === b.r) {
        for (let s = 0; s < 4; s++) if (s !== SUIT[a.s] && s !== SUIT[b.s]) outs += live(s, a.r);
      } else continue;
      out.push({ a: idxs[x], b: idxs[y], outs, run });
    }
    return out;
  }

  /* The cards the sequences still missing will need, by the kind of hand (see search): two sequences, one, or none. */
  const NEED_ROOM = [6, 3, 0, 3, 0];
  /* How far a hand is from a declare (lower is nearer): the hand is `cd.cards` without the card of exBit. */
  function distance(cd, exBit, live) {
    const { bestV, bestMask, bestJ } = search(cd, exBit, false);
    const n = cd.cards.length;
    const naturals = [];
    let total = cd.total;
    for (let i = 0; i < n; i++) if (!cd.jok[i]) { if (exBit & (1 << i)) total -= cd.val[i]; else naturals.push(i); }
    let pureOuts = -1;
    let best = Infinity;
    for (let cls = 4; cls >= 0; cls--) {
      if (bestV[cls] < 0) continue;
      const loose = naturals.filter((i) => !(bestMask[cls] & (1 << i)));
      const ds = draws(cd, loose, live).sort((p, q) => q.outs - p.outs);
      let credit = 0, usedMask = 0, seqOuts = 0, anyRun = false;
      for (const d of ds) {
        if (d.run) { anyRun = true; seqOuts += d.outs; }
        if (!d.outs || (usedMask & ((1 << d.a) | (1 << d.b)))) continue;
        usedMask |= (1 << d.a) | (1 << d.b);
        credit += W.draw * Math.min(d.outs, W.drawCap);
      }
      let pen = 0;
      if (cls === 3) pen = W.noSeq - W.seqOut * Math.min(seqOuts + (anyRun ? live.jokers : 0), W.seqCap);
      else if (cls < 3) {
        if (pureOuts < 0) { pureOuts = 0; for (const d of draws(cd, naturals, live)) if (d.run) pureOuts += d.outs; }
        pen = W.noPure - W.pureOut * Math.min(pureOuts, W.pureCap) + (cls === 0 ? W.bare : 0);
      }
      /* Room: a sequence still missing needs three cards, and only loose cards and spare jokers make room for them. A
         hand that is all sets has none: melds will have to be broken, however finished it looks. (Without this a hand
         of four sets looked 34 away from a declare it can never make, and was kept for ever.) */
      const need = NEED_ROOM[cls];
      if (need) { const short = need - loose.length - bestJ[cls]; if (short > 0) pen += W.room * short; }
      const e = total - bestV[cls] - credit + pen;
      if (e < best) best = e;
    }
    return best;
  }

  /* A card the next player can use is a gift: one that goes with what they took from the face-up pile. One they
     threw themselves, or left lying, is safe. */
  function danger(t, c) {
    const mem = t.mem, nx = t.next;
    if (!mem || nx == null || nx === t.seat || !mem.took[nx]) return 0;
    const near = (a, b) => {
      if (a.s !== b.s || a.r === b.r) return 0;
      const d = Math.min(Math.abs(a.r - b.r), a.r === 1 ? 14 - b.r : 99, b.r === 1 ? 14 - a.r : 99);
      return d === 1 ? 1 : d === 2 ? 0.6 : 0;
    };
    let d = 0;
    for (const k of mem.took[nx]) d += k.r === c.r && k.s !== c.s ? 1 : near(k, c);
    let safe = 0;
    for (const k of mem.threw[nx].concat(mem.passed[nx])) {
      if (k.s === c.s && k.r === c.r) safe = Math.max(safe, 0.8);
      else if (k.r === c.r) safe = Math.max(safe, 0.3);
      else if (near(k, c) === 1) safe = Math.max(safe, 0.2);
    }
    return d - safe;
  }

  function sharpDraw(t, noDrop) {
    const hand = t.hand, top = t.top, wr = t.wildRank;
    const live = liveTable(t, hand, t.open);
    let now = null;
    const distNow = () => (now === null ? (now = distance(candidates(hand, wr, W.card, W.pt), 0, live)) : now);
    /* The drop: only where points are carried on (a pool game), only on the first turn (20 points), only with three or
       more still in the deal (so a deal is never won by every bot walking away), never when the 20 would put it out. */
    if (!noDrop && t.pool && t.firstTurn && t.canDrop !== false && (t.active || 0) >= W.dropSeats && (t.poolLeft == null || t.poolLeft > 20) &&
      !hand.some((c) => isJoker(c, wr)) && distNow() >= W.dropAt) return "drop";
    if (!top || isJoker(top, wr)) return "closed";
    // only a card that goes with something in the hand is worth the look
    const goes = hand.some((o) => !isJoker(o, wr) && ((o.r === top.r && o.s !== top.s) ||
      (o.s === top.s && o.r !== top.r && (Math.abs(o.r - top.r) <= 2 || (top.r === 1 && o.r >= 12) || (o.r === 1 && top.r >= 12)))));
    if (!goes) return "closed";
    const withTop = hand.concat([top]);
    if (botFinishCard(withTop, wr, top.id)) return "open";
    const cd = candidates(withTop, wr, W.card, W.pt);
    const pile = t.open ? t.open.slice(0, -1) : [];
    const live2 = liveTable(t, withTop, pile);
    let open = Infinity;
    for (let i = 0; i < hand.length; i++) {
      if (cd.jok[i]) continue;
      const e = distance(cd, 1 << i, live2);
      if (e < open) open = e;
    }
    return open <= distNow() - W.take ? "open" : "closed";
  }

  function sharpPlay(t) {
    const hand = t.hand, wr = t.wildRank;
    const win = botFinishCard(hand, wr, t.pickedOpenId);
    if (win) return { declare: win };
    const cd = candidates(hand, wr, W.card, W.pt);
    const live = liveTable(t, hand, t.open);
    let best = null, bestE = Infinity;
    for (let i = 0; i < hand.length; i++) {
      const c = hand[i];
      if (c.id === t.pickedOpenId || cd.jok[i]) continue;
      const e = distance(cd, 1 << i, live) + W.danger * danger(t, c) - 0.01 * cardPoints(c, wr);
      if (e < bestE) { bestE = e; best = c; }
    }
    if (!best) best = botDiscardCard(hand, wr, t.pickedOpenId);
    return { discard: best.id };
  }

  /* A hand grouped so that a loss costs the least: the melds worth the most points that hold a pure sequence and a
     second sequence. Null when the hand has no such two (every card counts then, however it is grouped). */
  function sharpGroups(hand, wildRank) {
    const cd = candidates(hand, wildRank, 0, 1);
    const { bestV, bestPick } = search(cd, 0, true);
    if (bestV[4] < 0 || !bestPick[4]) return null;
    let used = 0;
    for (const i of bestPick[4]) used |= cd.melds[i].mask;
    const free = [];
    for (let i = 0; i < hand.length; i++) if (cd.jok[i] && !(used & (1 << i))) free.push(i);
    const groups = [];
    for (const i of bestPick[4]) {
      const m = cd.melds[i], g = [];
      for (let k = 0; k < hand.length; k++) if (m.mask & (1 << k)) g.push(hand[k].id);
      for (let k = 0; k < m.j; k++) { const f = free.pop(); if (f === undefined) return null; g.push(hand[f].id); }
      groups.push(g);
    }
    return groups;
  }

  /* ---------- the three levels' turns ---------- */
  /* t, the table as the seat whose turn it is may know it: { seat, hand, wildRank, wildCard, top, open (the face-up
     pile), pickedOpenId, mem, next (the seat that plays after it), firstTurn, pool (points are carried on), poolLeft
     (the points it can still take before it is out), active (seats still in the deal), rnd } */
  function draw(lv, t) {
    if (lv === "sharp") return sharpDraw(t);
    if (lv === "easy") return easyDraw(t);
    return botWantsOpen(t.hand, t.top, t.wildRank) ? "open" : "closed";
  }
  function play(lv, t) {
    if (lv === "sharp") return sharpPlay(t);
    if (lv === "easy") return easyPlay(t);
    const win = botFinishCard(t.hand, t.wildRank, t.pickedOpenId);
    if (win) return { declare: win };
    return { discard: botDiscardCard(t.hand, t.wildRank, t.pickedOpenId).id };
  }
  /* The grouping a level shows when someone else finishes: only sharp keeps its hand grouped. */
  function groups(lv, hand, wildRank) { return lv === "sharp" ? sharpGroups(hand, wildRank) : null; }

  return { LEVELS, level, EASY, W, memory, noteDraw, noteDiscard, draw, play, groups, _distance: (t, hand) => distance(candidates(hand, t.wildRank, W.card, W.pt), 0, liveTable(t, hand, t.open)) };
};
module.exports.LEVELS = LEVELS;
module.exports.level = level;
