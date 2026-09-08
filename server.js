const http = require("http");
const path = require("path");
const crypto = require("crypto");

/* =========================================================
   RUMMY ENGINE — pure logic, exported for the rules suite
   Cards: { id, s, r }  s in S,H,D,C ("J" = printed joker, r 0)
   wildRank: rank whose cards are jokers this game (printed joker
   drawn as wildcard => aces wild, wildRank 1)
   ========================================================= */

const SUITS = ["S", "H", "D", "C"];

function buildDeck() {
  const d = [];
  let id = 0;
  for (let copy = 0; copy < 2; copy++) {
    for (const s of SUITS) for (let r = 1; r <= 13; r++) d.push({ id: id++, s, r });
    d.push({ id: id++, s: "J", r: 0 });
  }
  return d; // 106
}

function isPrintedJoker(c) { return c.s === "J"; }
function isJoker(c, wildRank) { return c.s === "J" || c.r === wildRank; }
function cardPoints(c, wildRank) {
  if (isJoker(c, wildRank)) return 0;
  if (c.r === 1 || c.r >= 10) return 10;
  return c.r;
}

/* try a group as a SET given fixed naturals + joker count */
function trySet(nats, jokers) {
  const total = nats.length + jokers;
  if (total < 3 || total > 4) return false;
  if (nats.length === 0) return false;
  const r = nats[0].r;
  const suits = new Set();
  for (const c of nats) {
    if (c.r !== r) return false;
    if (suits.has(c.s)) return false;
    suits.add(c.s);
  }
  return true;
}

/* try a group as a SEQUENCE given fixed naturals + joker count.
   returns false | { gaps } (gaps=0 && jokers=0 means strictly consecutive) */
function trySeq(nats, jokers) {
  const total = nats.length + jokers;
  if (total < 3) return false;
  if (nats.length === 0) return { gaps: 0 }; // all-joker group: impure seq
  const suit = nats[0].s;
  for (const c of nats) if (c.s !== suit) return false;
  const aceTries = nats.some((c) => c.r === 1) ? [1, 14] : [0];
  for (const aceVal of aceTries) {
    const vals = nats.map((c) => (c.r === 1 ? aceVal : c.r));
    const set = new Set(vals);
    if (set.size !== vals.length) continue;
    const mn = Math.min(...vals), mx = Math.max(...vals);
    const span = mx - mn + 1;
    if (span > total) continue;
    // window of length total must fit in [1..14] (ace low occupies 1)
    if (total > 14) continue;
    const gaps = span - nats.length; // internal holes jokers must fill
    if (gaps > jokers) continue;
    // remaining jokers extend the ends; need room within [1..14]
    const extra = jokers - gaps;
    const room = (mn - 1) + (14 - mx);
    if (extra > room) continue;
    return { gaps };
  }
  return false;
}

/* validate one meld; wildRank cards may act as themselves or as jokers.
   returns { valid, type } type: "pure" | "seq" | "set" */
function validMeld(cards, wildRank) {
  if (!Array.isArray(cards) || cards.length < 3) return { valid: false, type: null };
  const printed = cards.filter(isPrintedJoker);
  const wilds = cards.filter((c) => !isPrintedJoker(c) && c.r === wildRank);
  const plain = cards.filter((c) => !isPrintedJoker(c) && c.r !== wildRank);
  let best = null; // pure > seq > set
  const rank = { pure: 3, seq: 2, set: 1 };
  const consider = (t) => { if (t && (!best || rank[t] > rank[best])) best = t; };
  const k = wilds.length;
  for (let mask = 0; mask < 1 << k; mask++) {
    const nats = plain.slice();
    let jokers = printed.length;
    for (let i = 0; i < k; i++) {
      if (mask & (1 << i)) nats.push(wilds[i]); else jokers++;
    }
    const seq = trySeq(nats, jokers);
    if (seq) {
      if (jokers === 0 && seq.gaps === 0 && nats.length === cards.length) consider("pure");
      else consider("seq");
    }
    if (trySet(nats, jokers)) consider("set");
    if (best === "pure") break;
  }
  return { valid: !!best, type: best };
}

/* groups: array of arrays of card ids. hand13: exactly the 13 cards kept.
   Valid declare: groups partition all 13, every group a valid meld,
   sequences >= 2 (pure or impure), pure sequences >= 1. */
function validateDeclare(hand13, groups, wildRank) {
  if (!Array.isArray(groups)) return { valid: false, reason: "no groups" };
  const byId = new Map(hand13.map((c) => [c.id, c]));
  const seen = new Set();
  const melds = [];
  for (const g of groups) {
    if (!Array.isArray(g) || g.length === 0) continue;
    const cards = [];
    for (const id of g) {
      const c = byId.get(id);
      if (!c) return { valid: false, reason: "card not in hand" };
      if (seen.has(id)) return { valid: false, reason: "card used twice" };
      seen.add(id);
      cards.push(c);
    }
    melds.push(cards);
  }
  if (seen.size !== hand13.length) return { valid: false, reason: "ungrouped cards" };
  let seqs = 0, pures = 0;
  for (const cards of melds) {
    const m = validMeld(cards, wildRank);
    if (!m.valid) return { valid: false, reason: "invalid meld" };
    if (m.type === "pure") { pures++; seqs++; }
    else if (m.type === "seq") seqs++;
  }
  if (pures < 1) return { valid: false, reason: "no pure sequence" };
  if (seqs < 2) return { valid: false, reason: "need two sequences" };
  return { valid: true };
}

/* score a LOSER's hand from their own grouping.
   If their valid melds include a pure seq and >=2 seqs, only the cards in
   invalid/leftover groups count; otherwise every non-joker card counts.
   Capped at 80. */
function scoreHand(hand, groups, wildRank) {
  const byId = new Map(hand.map((c) => [c.id, c]));
  const used = new Set();
  let seqs = 0, pures = 0;
  let deadPts = 0;
  const gs = Array.isArray(groups) ? groups : [];
  for (const g of gs) {
    if (!Array.isArray(g) || g.length === 0) continue;
    const cards = [];
    let ok = true;
    for (const id of g) {
      const c = byId.get(id);
      if (!c || used.has(id)) { ok = false; break; }
      cards.push(c);
    }
    if (!ok) continue;
    const m = validMeld(cards, wildRank);
    if (m.valid) {
      for (const c of cards) used.add(c.id);
      if (m.type === "pure") { pures++; seqs++; }
      else if (m.type === "seq") seqs++;
    }
  }
  for (const c of hand) if (!used.has(c.id)) deadPts += cardPoints(c, wildRank);
  let pts;
  if (pures >= 1 && seqs >= 2) pts = deadPts;
  else pts = hand.reduce((a, c) => a + cardPoints(c, wildRank), 0);
  return Math.min(80, pts);
}

/* bestArrangement: can these 13 cards be declared? DFS over candidate melds.
   Returns { groups } (arrays of ids) or null. Node-capped. */
function bestArrangement(cards, wildRank, cap) {
  cap = cap || 60000;
  let nodes = 0;
  const jokers = cards.filter((c) => isJoker(c, wildRank));
  const plain = cards.filter((c) => !isJoker(c, wildRank));
  plain.sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : a.r - b.r));
  const n = plain.length;

  function meldsStartingAt(idx, usedMask, jFree) {
    const out = [];
    const c0 = plain[idx];
    // SETS: same rank, distinct suits
    const sameRank = [];
    for (let i = idx + 1; i < n; i++)
      if (!(usedMask & (1n << BigInt(i))) && plain[i].r === c0.r && plain[i].s !== c0.s) sameRank.push(i);
    const suitsSeen = new Set([c0.s]);
    const distinct = [];
    for (const i of sameRank) if (!suitsSeen.has(plain[i].s)) { suitsSeen.add(plain[i].s); distinct.push(i); }
    const combos = [[]];
    for (const i of distinct) for (const c of combos.slice()) combos.push(c.concat([i]));
    for (const combo of combos) {
      const natCount = 1 + combo.length;
      for (let j = 0; j <= jFree; j++) {
        const total = natCount + j;
        if (total >= 3 && total <= 4) out.push({ idxs: [idx].concat(combo), j });
      }
    }
    // SEQUENCES: same suit ascending from c0, jokers fill gaps / extend
    const aceTries = c0.r === 1 ? [1, 14] : [c0.r];
    for (const v0 of aceTries) {
      // collect same-suit cards with value > v0 (ace high handled: only c0 may be ace here since sorted asc — an ace later same suit is a duplicate ace, value 1 or 14 too)
      const later = [];
      for (let i = idx + 1; i < n; i++) {
        if (usedMask & (1n << BigInt(i))) continue;
        if (plain[i].s !== c0.s) continue;
        const vals = plain[i].r === 1 ? [14] : [plain[i].r];
        for (const v of vals) if (v > v0) later.push({ i, v });
      }
      later.sort((a, b) => a.v - b.v);
      // DFS pick increasing values
      const pick = (pos, chosen, lastV, jUsed) => {
        const total = 1 + chosen.length + jUsed;
        if (total >= 3 && total <= 5) {
          for (let extra = 0; jUsed + extra <= jFree; extra++) {
            const t2 = total + extra;
            if (t2 >= 3 && t2 <= 5) {
              const room = (v0 - 1) + (14 - lastV);
              if (extra <= room) out.push({ idxs: [idx].concat(chosen.map((x) => x.i)), j: jUsed + extra });
            }
          }
        }
        if (total >= 5) return;
        for (let p = pos; p < later.length; p++) {
          const cand = later[p];
          if (cand.v <= lastV) continue;
          const gap = cand.v - lastV - 1;
          if (jUsed + gap > jFree) continue;
          if (1 + chosen.length + 1 + jUsed + gap > 5) continue;
          if (chosen.some((x) => x.v === cand.v)) continue;
          pick(p + 1, chosen.concat([cand]), cand.v, jUsed + gap);
        }
      };
      pick(0, [], v0, 0);
    }
    return out;
  }

  function dfs(usedMask, usedCount, jFree, melds) {
    if (++nodes > cap) return null;
    if (usedCount === n) {
      // leftover jokers: must form their own melds of 3+ (or attach — attaching handled by j in melds)
      let rest = jFree;
      const extra = [];
      while (rest >= 3) { const take = rest === 4 ? 4 : 3; extra.push({ idxs: [], j: take }); rest -= take; }
      if (rest !== 0) return null;
      const all = melds.concat(extra);
      let seqs = 0, pures = 0;
      const jokerPool = jokers.slice();
      const groups = [];
      for (const m of all) {
        const cs = m.idxs.map((i) => plain[i]);
        const js = jokerPool.splice(0, m.j);
        const cards2 = cs.concat(js);
        const v = validMeld(cards2, wildRank);
        if (!v.valid) return null;
        if (v.type === "pure") { pures++; seqs++; } else if (v.type === "seq") seqs++;
        groups.push(cards2.map((c) => c.id));
      }
      if (pures >= 1 && seqs >= 2) return { groups };
      return null;
    }
    let idx = 0;
    while (usedMask & (1n << BigInt(idx))) idx++;
    const options = meldsStartingAt(idx, usedMask, jFree);
    for (const opt of options) {
      let m2 = usedMask;
      for (const i of opt.idxs) m2 |= 1n << BigInt(i);
      const r = dfs(m2, usedCount + opt.idxs.length, jFree - opt.j, melds.concat([opt]));
      if (r) return r;
      if (nodes > cap) return null;
    }
    return null;
  }
  if (plain.length === 0) {
    // 13 jokers (absurd) — 3+3+3+4
    return { groups: [] };
  }
  return dfs(0n, 0, jokers.length, []);
}

/* =========================================================
   SERVER
   ========================================================= */
function startServer() {
  const express = require("express");
  const { Server } = require("socket.io");

  const app = express();
  const BASE = (process.env.BASE_PATH || "").replace(/\/$/, "");
  if (BASE) app.use((req, res, next) => { if (req.path === BASE) return res.redirect(301, BASE + "/"); next(); });
  app.use(BASE || "/", express.static(path.join(__dirname, "public")));
  const server = http.createServer(app);
  const io = new Server(server, { path: BASE + "/socket.io", cors: { origin: true } });

  const PORT = process.env.PORT || 3000;
  const MAX_PLAYERS = 6;
  const TURN_MS = Number(process.env.TURN_MS || 45000);
  const BOT_MS = Math.max(1, Number(process.env.BOT_MS || 1200));
  const AFK_MS = Math.max(200, Number(process.env.AFK_MS || 5000));   // T1: turn clock while the current player is disconnected
  const TIMEOUTS_TO_BOT = 3;                                              // consecutive timeouts before a bot takes the seat

  const rooms = new Map();
  const roomSockets = new Map();
  const timers = new Map();
  const botTimers = new Map();

  const newId = () => crypto.randomBytes(8).toString("hex");
  const newCode = () => {
    const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let c = "";
    for (let i = 0; i < 6; i++) c += A[crypto.randomInt(A.length)];
    return rooms.has(c) ? newCode() : c;
  };
  const BOT_NAMES = ["Robo", "Chip", "Bolt", "Turbo", "Pixel", "Gizmo"];
  const clean = (s, n) => String(s || "").replace(/[<>]/g, "").trim().slice(0, n);

  function clearT(map, code) { const t = map.get(code); if (t) { clearTimeout(t); map.delete(code); } }
  function deleteRoom(code) { clearT(timers, code); clearT(botTimers, code); rooms.delete(code); roomSockets.delete(code); }

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function activeSeats(room) {
    return room.players.map((p, i) => (!p.left && !p.out ? i : -1)).filter((i) => i >= 0);
  }

  function setupGame(room) {
    const deck = shuffle(buildDeck());
    room.players.forEach((p) => { p.left = p.left || false; p.out = false; });
    room.hands = room.players.map(() => []);
    room.groups = room.players.map(() => []);
    for (let k = 0; k < 13; k++)
      for (let i = 0; i < room.players.length; i++)
        if (!room.players[i].left) room.hands[i].push(deck.pop());
    let wild = deck.pop();
    room.wildCard = wild;
    room.wildRank = wild.s === "J" ? 1 : wild.r;
    room.open = [deck.pop()];
    room.closed = deck;
    const seats = activeSeats(room);
    room.turn = seats[crypto.randomInt(seats.length)];
    room.phase = "draw";
    room.pickedOpenId = null;
    room.lastMove = null;
    room.winner = null;
    room.results = null;
    room.status = "playing";
    const wname = wild.s === "J" ? "the printed joker — ACES are wild" : rankName(wild.r) + " is wild";
    room.log = `${room.players[room.turn].name} goes first. Wildcard: ${wname}.`;
    armTimer(room.code);
  }

  function rankName(r) { return ["", "A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"][r] || r; }

  function nextTurn(room) {
    const seats = activeSeats(room);
    if (seats.length === 0) return;
    let s = room.turn;
    do { s = (s + 1) % room.players.length; } while (!seats.includes(s));
    room.turn = s;
    room.phase = "draw";
    room.pickedOpenId = null;
  }

  function reshuffleIfNeeded(room) {
    if (room.closed.length === 0 && room.open.length > 1) {
      const top = room.open.pop();
      room.closed = shuffle(room.open);
      room.open = [top];
      room.log = "Closed pile refilled from the discards.";
    }
  }

  function doDraw(room, seat, from) {
    if (from === "open") {
      if (room.open.length === 0) return false;
      const c = room.open.pop();
      room.hands[seat].push(c);
      room.pickedOpenId = c.id;
      room.lastMove = { seat, kind: "drawOpen", card: c };
      room.log = `${room.players[seat].name} picked up the ${cardName(c)}.`;
    } else {
      reshuffleIfNeeded(room);
      if (room.closed.length === 0) return false;
      const c = room.closed.pop();
      room.hands[seat].push(c);
      room.lastMove = { seat, kind: "draw" };
      room.log = `${room.players[seat].name} drew from the closed pile.`;
    }
    room.phase = "discard";
    return true;
  }

  function doDiscard(room, seat, id) {
    const hand = room.hands[seat];
    const idx = hand.findIndex((c) => c.id === id);
    if (idx < 0) return false;
    if (room.pickedOpenId === id) return false; // can't throw back what you just picked
    const [c] = hand.splice(idx, 1);
    room.groups[seat] = room.groups[seat].map((g) => g.filter((x) => x !== id)).filter((g) => g.length);
    room.open.push(c);
    room.lastMove = { seat, kind: "discard", card: c };
    room.log = `${room.players[seat].name} discarded the ${cardName(c)}.`;
    nextTurn(room);
    return true;
  }

  function finishGame(room, declarerSeat) {
    room.status = "over";
    room.phase = "over";
    room.winner = declarerSeat;
    room.results = room.players.map((p, i) => {
      if (i === declarerSeat) return { seat: i, points: 0, declared: true };
      if (p.out) return { seat: i, points: 80, wrong: true };
      if (p.left) return { seat: i, points: 80, left: true };
      return { seat: i, points: scoreHand(room.hands[i], room.groups[i], room.wildRank) };
    }).sort((a, b) => a.points - b.points);
    room.log = `${room.players[declarerSeat].name} declared — VALID! ${room.players[declarerSeat].name.toUpperCase()} WINS! 🎉`;
    clearT(timers, room.code); clearT(botTimers, room.code);
  }

  function doDeclare(room, seat, discardId, groups) {
    const hand = room.hands[seat];
    const idx = hand.findIndex((c) => c.id === discardId);
    if (idx < 0) return false;
    if (room.pickedOpenId === discardId) return false;
    const kept = hand.filter((c) => c.id !== discardId);
    if (kept.length !== 13) return false;
    const v = validateDeclare(kept, groups, room.wildRank);
    const [fc] = hand.splice(idx, 1);
    room.open.push(fc);
    if (v.valid) {
      room.groups[seat] = groups;
      finishGame(room, seat);
    } else {
      const p = room.players[seat];
      p.out = true;
      room.lastMove = { seat, kind: "wrong" };
      room.log = `${p.name} declared… and it was WRONG (${v.reason}). 80 points and out.`;
      const act = activeSeats(room);
      if (act.length === 1) {
        finishGame(room, act[0]);
        room.log = `${room.players[act[0]].name} is the last one standing after a wrong declare — they win!`;
      } else if (room.turn === seat) {
        nextTurn(room);
      }
    }
    return true;
  }

  function cardName(c) {
    if (c.s === "J") return "Joker";
    const suits = { S: "♠", H: "♥", D: "♦", C: "♣" };
    return rankName(c.r) + suits[c.s];
  }

  /* ---------- per-player state ---------- */
  function stateFor(room, seat) {
    return {
      code: room.code, status: room.status, phase: room.phase,
      turn: room.turn,
      wildCard: room.wildCard || null,
      wildRank: room.wildRank || null,
      openTop: room.open && room.open.length ? room.open.slice(-4) : [],
      closedCount: room.closed ? room.closed.length : 0,
      log: room.log, winner: room.winner, results: room.results,
      hostSeat: room.players.findIndex((p) => p.id === room.host),
      lastMove: room.lastMove, phaseEndsAt: room.phaseEndsAt || null,
      maxPlayers: MAX_PLAYERS,
      players: room.players.map((p, i) => ({
        name: p.name, avatar: p.avatar, bot: !!p.bot, botControlled: !!p.botControlled, left: p.left, out: !!p.out, connected: p.connected,
        count: room.hands && room.hands[i] ? room.hands[i].length : 0,
      })),
      yourHand: room.hands && seat >= 0 && room.hands[seat] ? room.hands[seat] : [],
      yourGroups: room.groups && seat >= 0 && room.groups[seat] ? room.groups[seat] : [],
      pickedOpenId: seat === room.turn ? room.pickedOpenId : null,
      voice: room.voice ? Array.from(room.voice) : [],
      chat: (room.chat || []).slice(-60),
    };
  }
  function bump(room) { room.v = (room.v || 0) + 1; room.touched = Date.now(); sendState(room.code); }

  /* ---------- GameNest push (optional; no-op without PUSH_URL) ----------
     The app registers a device token per socket and reports presence; players who are away or disconnected
     get a push when it becomes their turn / a new phase starts, and when someone writes in chat. */
  const PUSH_URL = process.env.PUSH_URL || "";
  const PUSH_TITLE = 'Rummy';
  function pushTo(p, body, data, collapse) {
    if (!PUSH_URL || !p || !p.pushToken || p.bot || p.left) return;
    if (!(p.away || !p.connected)) return;
    const now = Date.now(); if (p._lastPush && now - p._lastPush < 4000) return; p._lastPush = now;
    fetch(PUSH_URL + "/notify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: p.pushToken, title: PUSH_TITLE, body, data: data || {}, collapse: collapse || undefined }) }).catch(() => {});
  }
  function pushTurn(room) {   // called after every state broadcast; only fires when the situation changes
    const key = room.status + "|" + room.turn;
    if (room._pushKey === key) return; room._pushKey = key;
    if (room.status !== "playing") return;
    const p = room.players[room.turn]; if (!p) return;
    pushTo(p, "Your turn in " + PUSH_TITLE + " — room " + room.code, { code: room.code, game: PUSH_TITLE }, room.code + "-turn");
  }

  function sendState(code) {
    const room = rooms.get(code);
    const socks = roomSockets.get(code);
    if (!room || !socks) return;
    for (const s of socks) {
      const seat = room.players.findIndex((p) => p.id === s.data.playerId);
      s.emit("state", { room: stateFor(room, seat), mySeat: seat, v: room.v });
      try { pushTurn(room); } catch (_) {}
    }
  }

  function armTimer(code) {
    const room = rooms.get(code);
    clearT(timers, code);
    scheduleBot(code);
    if (!room || room.status !== "playing") return;
    const cur = room.players[room.turn];
    const ms = cur && !cur.bot && !cur.botControlled && !cur.connected ? AFK_MS : TURN_MS;
    room.phaseEndsAt = Date.now() + ms;
    timers.set(code, setTimeout(() => onTurnTimeout(code), ms));
  }

  /* T1 AFK policy: a timed-out turn is auto-played with the bot heuristic instead of skipped;
     three consecutive timeouts hand the seat to the bot until the human acts or reconnects. */
  function onTurnTimeout(code) {
    const r = rooms.get(code);
    if (!r || r.status !== "playing") return;
    const pl = r.players[r.turn];
    if (!pl) return;
    let note = "";
    if (!pl.bot && !pl.botControlled) {
      pl.timeouts = (pl.timeouts || 0) + 1;
      if (pl.timeouts >= TIMEOUTS_TO_BOT) { pl.botControlled = true; note = `A bot is playing for ${pl.name} (timed out ${TIMEOUTS_TO_BOT} times).`; }
      else note = `${pl.name} ran out of time; the turn was played for them.`;
    }
    botAct(r);
    if (note) r.log = `${note} ${r.log || ""}`.trim();
    bump(r);
    if (r.status === "playing") armTimer(code);
  }

  /* The human acts (or reconnects): take the seat back from the bot and reset the timeout streak. */
  function humanIsBack(room, p, reason) {
    const wasBot = !!p.botControlled;
    p.timeouts = 0;
    if (!wasBot) return false;
    p.botControlled = false;
    room.log = `${p.name} is back at the table${reason ? " (" + reason + ")" : ""}.`;
    if (room.status === "playing" && room.players[room.turn] === p) { clearT(botTimers, room.code); armTimer(room.code); }
    return true;
  }

  /* ---------- bots ---------- */
  function addBotTo(room) {
    if (room.players.length >= MAX_PLAYERS) return null;
    const used = room.players.map((q) => q.name);
    const name = BOT_NAMES.find((n) => !used.includes(n)) || "Bot" + (room.players.length + 1);
    const p = { id: "bot_" + newId(), name, avatar: "\u{1F916}", bot: true, left: false, connected: true };
    room.players.push(p);
    return p;
  }
  function scheduleBot(code) {
    clearT(botTimers, code);
    const room = rooms.get(code);
    if (!room || room.status !== "playing") return;
    const p = room.players[room.turn];
    if (!p || !(p.bot || p.botControlled)) return;
    botTimers.set(code, setTimeout(() => {
      const r = rooms.get(code);
      if (!r || r.status !== "playing") return;
      const cur = r.players[r.turn];
      if (!cur || !(cur.bot || cur.botControlled)) return;
      botAct(r);
      bump(r);
      if (r.status === "playing") armTimer(code);
    }, BOT_MS + crypto.randomInt(BOT_MS)));
  }
  function botUseful(room, seat, card) {
    if (isJoker(card, room.wildRank)) return true;
    for (const c of room.hands[seat]) {
      if (c.id === card.id) continue;
      if (c.r === card.r && c.s !== card.s) return true;
      if (c.s === card.s && Math.abs(c.r - card.r) <= 2 && c.r !== card.r) return true;
      if (c.s === card.s && (card.r === 1 && c.r >= 12)) return true;
    }
    return false;
  }
  function botAct(room) {
    const seat = room.turn;
    if (room.phase === "draw") {
      const top = room.open[room.open.length - 1];
      const from = top && botUseful(room, seat, top) && !isJoker(top, room.wildRank) ? "open" : "closed";
      if (!doDraw(room, seat, from)) { if (!doDraw(room, seat, from === "open" ? "closed" : "open")) { nextTurn(room); return; } }
    }
    // try to win: for a few discard candidates, solve the kept 13
    const hand = room.hands[seat];
    const candidates = hand
      .filter((c) => c.id !== room.pickedOpenId)
      .map((c) => ({ c, pts: cardPoints(c, room.wildRank), useful: botUseful(room, seat, c) }))
      .sort((a, b) => (a.useful === b.useful ? b.pts - a.pts : a.useful ? 1 : -1));
    for (const cand of candidates.slice(0, 3)) {
      const kept = hand.filter((c) => c.id !== cand.c.id);
      const win = bestArrangement(kept, room.wildRank, 30000);
      if (win) { doDeclare(room, seat, cand.c.id, win.groups); return; }
    }
    const throwAway = candidates[0] || { c: hand.find((c) => c.id !== room.pickedOpenId) || hand[0] };
    doDiscard(room, seat, throwAway.c.id);
  }

  /* ---------- sockets ---------- */

  /* T3: the host seat follows the humans — first connected human, else first human still seated, else unchanged. */
  function ensureHost(room) {
    const cur = room.players.find((p) => p.id === room.host);
    if (cur && !cur.bot && !cur.left && cur.connected) return false;
    const next = room.players.find((p) => !p.bot && !p.left && p.connected) || room.players.find((p) => !p.bot && !p.left);
    if (!next || next.id === room.host) return false;
    room.host = next.id;
    room.log = `${next.name} is now the host.`;
    return true;
  }

  io.on("connection", (socket) => {
    socket.data.playerId = null;
    socket.data.code = null;
    const currentRoom = () => rooms.get(socket.data.code);
    const attach = (code) => {
      socket.data.code = code;
      if (!roomSockets.has(code)) roomSockets.set(code, new Set());
      roomSockets.get(code).add(socket);
    };
    const detach = () => {
      const set = roomSockets.get(socket.data.code);
      if (set) set.delete(socket);
      socket.data.code = null;
    };
    const mySeat = (room) => room.players.findIndex((p) => p.id === socket.data.playerId);

    socket.on("create", ({ name, playerId, avatar } = {}) => {
      name = clean(name, 18); if (!name) return socket.emit("err", "Pick a name first.");
      const code = newCode();
      const room = { code, status: "lobby", host: playerId, players: [], chat: [], log: "", v: 1,
        touched: Date.now(), voice: new Set(), phase: "lobby" };
      room.players.push({ id: playerId, name, avatar: clean(avatar, 4) || "\u{1F0CF}", bot: false, left: false, connected: true });
      rooms.set(code, room);
      socket.data.playerId = playerId;
      attach(code);
      socket.emit("joined", { code });
      bump(room);
    });

    socket.on("join", ({ code, name, playerId, avatar } = {}) => {
      code = clean(code, 6).toUpperCase();
      const room = rooms.get(code);
      if (!room) return socket.emit("err", "No room with that code.");
      socket.data.playerId = playerId;
      const existing = room.players.find((p) => p.id === playerId);
      if (existing) { existing.connected = true; existing.left = false; humanIsBack(room, existing, "reconnected"); attach(code); socket.emit("joined", { code }); bump(room); if (room.status === "playing" && room.players[room.turn] === existing) armTimer(code); return; }
      if (room.status !== "lobby") return socket.emit("err", "That game already started.");
      if (room.players.length >= MAX_PLAYERS) return socket.emit("err", "Room is full (6).");
      name = clean(name, 18); if (!name) return socket.emit("err", "Pick a name first.");
      room.players.push({ id: playerId, name, avatar: clean(avatar, 4) || "\u{1F0CF}", bot: false, left: false, connected: true });
      attach(code);
      socket.emit("joined", { code });
      room.log = `${name} joined.`;
      bump(room);
    });

    socket.on("addBot", () => {
      const room = currentRoom();
      if (!room || room.status !== "lobby" || room.host !== socket.data.playerId) return;
      const b = addBotTo(room);
      if (b) { room.log = `${b.name} (bot) joined.`; bump(room); }
    });
    socket.on("removeBot", () => {
      const room = currentRoom();
      if (!room || room.status !== "lobby" || room.host !== socket.data.playerId) return;
      for (let i = room.players.length - 1; i >= 0; i--) if (room.players[i].bot) { room.players.splice(i, 1); break; }
      bump(room);
    });

    socket.on("start", () => {
      const room = currentRoom();
      if (!room || room.status !== "lobby" || room.host !== socket.data.playerId) return;
      if (room.players.filter((p) => !p.left).length < 2) return socket.emit("err", "Need at least 2 players — add a bot.");
      setupGame(room);
      bump(room);
    });

    socket.on("draw", ({ from } = {}) => {
      const room = currentRoom();
      if (!room || room.status !== "playing") return;
      { const self = room.players[mySeat(room)]; if (self && humanIsBack(room, self, "took the seat back")) bump(room); }   // any action reclaims a bot-controlled seat
      if (room.phase !== "draw") return;
      const seat = mySeat(room);
      if (seat !== room.turn) return;
      if (from !== "open" && from !== "closed") return;
      if (doDraw(room, seat, from)) { bump(room); armTimer(room.code); }
      else socket.emit("err", "That pile is empty.");
    });

    socket.on("discard", ({ id } = {}) => {
      const room = currentRoom();
      if (!room || room.status !== "playing") return;
      { const self = room.players[mySeat(room)]; if (self && humanIsBack(room, self, "took the seat back")) bump(room); }   // any action reclaims a bot-controlled seat
      if (room.phase !== "discard") return;
      const seat = mySeat(room);
      if (seat !== room.turn) return;
      if (!Number.isInteger(id)) return;
      if (room.pickedOpenId === id) return socket.emit("err", "You can't discard the card you just picked up.");
      if (doDiscard(room, seat, id)) { bump(room); armTimer(room.code); }
    });

    socket.on("arrange", ({ groups } = {}) => {
      const room = currentRoom();
      if (!room || room.status !== "playing") return;
      const seat = mySeat(room);
      if (seat < 0 || !room.hands[seat]) return;
      if (!Array.isArray(groups) || groups.length > 8) return;
      const ids = new Set(room.hands[seat].map((c) => c.id));
      const seen = new Set();
      const cleaned = [];
      for (const g of groups) {
        if (!Array.isArray(g)) return;
        const cg = [];
        for (const id of g) {
          if (!Number.isInteger(id) || !ids.has(id) || seen.has(id)) continue;
          seen.add(id); cg.push(id);
        }
        if (cg.length) cleaned.push(cg);
      }
      room.groups[seat] = cleaned;
      room.touched = Date.now();
      socket.emit("state", { room: stateFor(room, seat), mySeat: seat, v: room.v });
    });

    socket.on("declare", ({ discardId, groups } = {}) => {
      const room = currentRoom();
      if (!room || room.status !== "playing") return;
      { const self = room.players[mySeat(room)]; if (self && humanIsBack(room, self, "took the seat back")) bump(room); }   // any action reclaims a bot-controlled seat
      if (room.phase !== "discard") return;
      const seat = mySeat(room);
      if (seat !== room.turn) return;
      if (!Number.isInteger(discardId)) return;
      if (doDeclare(room, seat, discardId, Array.isArray(groups) ? groups : room.groups[seat])) {
        bump(room);
        if (room.status === "playing") armTimer(room.code);
      }
    });
    socket.on("takeSeat", () => {
      const room = currentRoom(); if (!room) return;
      const self = room.players[mySeat(room)];
      if (self && humanIsBack(room, self, "took the seat back")) bump(room);
    });
    socket.on("pushToken", ({ token } = {}) => { const room = currentRoom(); if (!room) return; const p = room.players.find((q) => q.id === socket.data.playerId); if (p && typeof token === "string" && /^[0-9a-f]{32,200}$/i.test(token)) p.pushToken = token; });
    socket.on("presence", ({ away } = {}) => { const room = currentRoom(); if (!room) return; const p = room.players.find((q) => q.id === socket.data.playerId); if (p) p.away = !!away; });


    socket.on("chat", ({ t } = {}) => {
      const room = currentRoom();
      if (!room) return;
      const seat = mySeat(room);
      const me = room.players[seat];
      if (!me || me.left) return;
      const now = Date.now();
      if (me._lastChat && now - me._lastChat < 700) return;
      me._lastChat = now;
      t = clean(t, 140); if (!t) return;
      room.chat.push({ n: me.name, a: me.avatar, t }); for (const q of room.players) if (q !== me) pushTo(q, me.name + ": " + t, { code: room.code, game: PUSH_TITLE }, room.code + "-chat");
      if (room.chat.length > 200) room.chat.splice(0, room.chat.length - 200);
      bump(room);
    });

    socket.on("voice", ({ kind, to, data } = {}) => {
      const room = currentRoom();
      if (!room) return;
      const seat = mySeat(room);
      if (seat < 0) return;
      if (kind === "join" || kind === "leave") {
        if (!room.voice) room.voice = new Set();
        if (kind === "join") room.voice.add(seat); else room.voice.delete(seat);
        bump(room);
        return;
      }
      if (kind === "signal" && Number.isInteger(to) && data) {
        let size = 0; try { size = JSON.stringify(data).length; } catch (e) { return; }
        if (size > 20000) return;
        const socks = roomSockets.get(room.code);
        if (!socks) return;
        for (const s of socks) {
          const sSeat = room.players.findIndex((p) => p.id === s.data.playerId);
          if (sSeat === to) s.emit("voice", { kind: "signal", from: seat, data });
        }
      }
    });

    socket.on("rematch", () => {
      const room = currentRoom();
      if (!room || room.status !== "over" || room.host !== socket.data.playerId) return;
      room.players = room.players.filter((p) => !p.left);
      if (room.players.filter((p) => !p.bot).length === 0) { deleteRoom(room.code); return; }
      if (room.players.length < 2) { room.status = "lobby"; room.phase = "lobby"; room.log = "Back to the lobby."; bump(room); return; }
      setupGame(room);
      bump(room);
    });

    function handleLeave() {
      const room = currentRoom();
      if (!room) return detach();
      const p = room.players.find((q) => q.id === socket.data.playerId);
      if (!p) return detach();
      if (room.voice) room.voice.delete(room.players.indexOf(p));
      if (room.status === "lobby") {
        room.players = room.players.filter((q) => q.id !== p.id);
        if (room.players.length === 0 || room.players.every((q) => q.bot)) { detach(); deleteRoom(room.code); return; }
        if (room.host === p.id) room.host = (room.players.find((q) => !q.bot) || room.players[0]).id;
        room.log = `${p.name} left.`;
      } else {
        const seat = room.players.indexOf(p);
        p.left = true; p.connected = false;
        if (room.players.every((q) => q.bot || q.left)) { detach(); deleteRoom(room.code); return; }
        if (room.host === p.id) room.host = (room.players.find((q) => !q.bot && !q.left) || room.players[0]).id;
        room.log = `${p.name} left the game.`;
        if (room.status === "playing") {
          const act = activeSeats(room);
          if (act.length === 1) {
            finishGame(room, act[0]);
            room.log = `${room.players[act[0]].name} is the last one standing — they win!`;
          } else if (room.turn === seat) {
            nextTurn(room);
            armTimer(room.code);
          }
        }
      }
      detach();
      bump(room);
    }
    socket.on("leave", () => handleLeave());
    socket.on("disconnect", () => {
      const room = currentRoom();
      if (!room) return;
      const p = room.players.find((q) => q.id === socket.data.playerId);
      if (p) { p.connected = false; if (room.voice) room.voice.delete(room.players.indexOf(p)); ensureHost(room); room.v++; }
      detach();
      if (rooms.has(room.code)) sendState(room.code);
      if (p && rooms.has(room.code) && room.status === "playing" && room.players[room.turn] === p) armTimer(room.code);   // 5 s clock while they are away
    });
  });

  setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) if (now - room.touched > 2 * 60 * 60 * 1000) deleteRoom(code);
  }, 10 * 60 * 1000);

  server.listen(PORT, () => console.log("Rummy running on port " + PORT));
}

module.exports = {
  buildDeck, isJoker, isPrintedJoker, cardPoints,
  validMeld, validateDeclare, scoreHand, bestArrangement,
};

if (require.main === module) startServer();
