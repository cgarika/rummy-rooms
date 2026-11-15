/*
 Rummy — the worlds lane's server changes.
 Run:  node test/worlds.js   (starts its own servers on TEST_PORT2 / TEST_PORT3, defaults 3421 / 3431)
 Proves:
 - the bot's deadwood is T11's exactly: on 4,000 random hands (13 and 14 cards, every wild rank, printed jokers)
   the remembered, bounded search gives the same number as T11's search with no node cap;
 - bot turns run from a queue in slices, so a room full of busy bots does not hold up a human's move
   (40 all-bot rooms at BOT_MS=5 around one human table: the human's moves stay quick, the bot games finish);
 - GN-10 every state after a draw or a discard already carries the new deadline (phaseEndsAt - serverNow = TURN_MS);
 - GN-05 refusals carry a machine reason: a "refusal" event { code, message, op } and err's second argument
   (not_found, name_required, not_enough_players, full, started, joker_from_open, picked_card, not_your_drop);
 - GN-20 one room per socket, and a rejoin survives its old socket; GN-30 names cut between whole characters;
 - GN-48 serverNow and features in every state; every old field unchanged and first.
*/
"use strict";
const { io } = require("socket.io-client");
const { spawn } = require("child_process");
const path = require("path");
const E = require("../server.js");
const { cardPoints, isJoker, validMeld } = E;
function popcount(x) { let c = 0; while (x) { x &= x - 1; c++; } return c; }
/* T11's deadwood as it shipped, the oracle (copied from cb41ac8) */
function deadwoodT11(cards, wildRank, cap) {
  cap = cap || 20000;
  const n = cards.length;
  const pts = cards.map((c) => cardPoints(c, wildRank));
  const total = pts.reduce((a, b) => a + b, 0);
  if (n < 3 || total === 0) return total;
  const jokerBits = cards.reduce((m, c, i) => (isJoker(c, wildRank) ? m | (1 << i) : m), 0);
  const nJokers = cards.filter((c) => isJoker(c, wildRank)).length;
  const JK = { id: -1, s: "J", r: 0 };
  const melds = [];   // { mask (naturals), j (jokers needed), v (points melded) }
  const seen = new Set();
  const add = (idxs, j) => {
    if (idxs.length + j < 3 || idxs.length + j > (idxs.length ? 5 : 3)) return;
    let mask = 0, v = 0; for (const i of idxs) { mask |= 1 << i; v += pts[i]; }
    if (v === 0) return;   // nothing to gain from melding jokers alone
    const key = mask + ":" + j; if (seen.has(key)) return; seen.add(key);
    const probe = idxs.map((i) => cards[i]); for (let k = 0; k < j; k++) probe.push(JK);
    if (validMeld(probe, wildRank).valid) melds.push({ mask, j, v });
  };
  const nat = cards.map((c, i) => ({ c, i })).filter((x) => !isJoker(x.c, wildRank));
  // sets: same rank, one card per suit
  const byRank = {};
  for (const x of nat) (byRank[x.c.r] = byRank[x.c.r] || {})[x.c.s] = byRank[x.c.r][x.c.s] ?? x.i;
  for (const r of Object.keys(byRank)) {
    const suits = Object.values(byRank[r]);
    for (let m = 1; m < 1 << suits.length; m++) {
      const idxs = suits.filter((_, k) => m & (1 << k));
      for (let j = 0; j <= Math.min(nJokers, 4 - idxs.length); j++) if (idxs.length + j >= 3 && idxs.length + j <= 4) add(idxs, j);
    }
  }
  // runs: same suit, consecutive ranks (ace low or high), jokers fill holes
  const bySuit = {};
  for (const x of nat) { const m = (bySuit[x.c.s] = bySuit[x.c.s] || {}); m[x.c.r] = m[x.c.r] ?? x.i; if (x.c.r === 1) m[14] = m[14] ?? x.i; }
  for (const suit of Object.keys(bySuit)) {
    const have = bySuit[suit];
    for (let len = 3; len <= 5; len++) for (let a = 1; a + len - 1 <= 14; a++) {
      const idxs = []; let j = 0;
      for (let r = a; r < a + len; r++) { if (have[r] != null) idxs.push(have[r]); else j++; }
      if (a <= 1 && a + len - 1 >= 14) continue;   // an ace can't be both ends
      if (idxs.length && j <= nJokers && new Set(idxs).size === idxs.length) add(idxs, j);
    }
  }
  melds.sort((a, b) => b.v - a.v);
  let best = 0, nodes = 0;
  const go = (k, mask, jUsed, acc) => {
    if (acc > best) best = acc;
    if (++nodes > cap) return;
    for (let i = k; i < melds.length; i++) {
      const m = melds[i];
      if (m.mask & mask) continue;
      const usedAsNatural = popcount((mask | m.mask) & jokerBits);
      if (jUsed + m.j > nJokers - usedAsNatural) continue;
      go(i + 1, mask | m.mask, jUsed + m.j, acc + m.v);
    }
  };
  go(0, 0, 0, 0);
  return total - best;
}

const PORT = Number(process.env.TEST_PORT2 || 3421), PORT_B = Number(process.env.TEST_PORT3 || 3431), TURN = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(10); } return false; };
let n = 0;
const pid = () => "r" + (++n) + "_" + Math.random().toString(36).slice(2, 8);
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const OLD_FIELDS = ["code", "status", "phase", "turn", "wildCard", "wildRank", "openTop", "closedCount", "log", "winner", "results", "pool", "totals", "champion", "hostSeat", "lastMove", "phaseEndsAt", "maxPlayers", "players", "yourHand", "yourGroups", "pickedOpenId", "voice", "chat"];
const server = (port, env) => spawn(process.execPath, ["server.js"], { cwd: path.join(__dirname, ".."), env: { ...process.env, PORT: String(port), TURN_MS: String(TURN), BOT_MS: "5", TEST_HOOKS: "1", ...env }, stdio: "ignore" });

(async () => {
  // ---- deadwood: the same answers as T11
  {
    let seed = 99; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; };
    let diff = 0, first = null;
    for (let k = 0; k < 4000; k++) {
      const deck = E.buildDeck();
      for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
      const hand = deck.slice(0, 13 + (k % 2)), wr = 1 + (k % 13);
      const a = E.deadwood(hand, wr), b = deadwoodT11(hand, wr, 1e9);
      if (a !== b) { diff++; first = first || { hand, wr, a, b }; }
      if (E.deadwood(hand.slice().reverse(), wr) !== a) { diff++; first = first || { order: true }; }
    }
    assert(diff === 0, "deadwood differs from T11's on " + diff + " hands: " + JSON.stringify(first));
    console.log("PASS deadwood — 4,000 random hands, the same as T11's uncapped search (remembered answers match fresh ones)");
  }
  const srv = server(PORT, {});
  const socks = [];
  const open = (url) => {
    const c = io(url || "http://localhost:" + PORT, { transports: ["websocket"], reconnection: false, forceNew: true });
    c.st = null; c.seat = -1; c.frames = []; c.errs = []; c.refusals = []; c.codes = []; c.joined = null;
    c.on("state", (f) => { c.frames.push(f); c.st = f.room; c.seat = f.mySeat; });
    c.on("err", (text, meta) => c.errs.push({ text, meta }));
    c.on("refusal", (r) => c.refusals.push(r));
    c.on("joined", (j) => { c.joined = j.code; c.codes.push(j.code); });
    socks.push(c);
    return c;
  };
  const table = async (count, url) => {
    const cs = [];
    for (let i = 0; i < count; i++) cs.push(open(url));
    await until(() => cs.every((c) => c.connected));
    cs[0].emit("create", { name: "P0", playerId: pid() });
    await until(() => cs[0].joined);
    for (let i = 1; i < count; i++) cs[i].emit("join", { code: cs[0].joined, name: "P" + i, playerId: pid() });
    await until(() => cs.every((c) => c.st && c.st.players.length === count));
    return cs;
  };
  const move = (c) => {   // what today's app would send on its turn: draw from the closed pile, then throw the first card it may
    const r = c.st;
    if (r.phase === "draw") c.emit("draw", { from: "closed" });
    else if (r.phase === "discard") { const card = r.yourHand.find((x) => x.id !== r.pickedOpenId); c.emit("discard", { id: card.id }); }
  };
  try {
    await sleep(700);
    // ---- today's app: fields
    {
      const [A] = await table(2);
      A.emit("start");
      await until(() => A.st.status === "playing");
      const keys = Object.keys(A.st);
      // ranked, rankedModel, rankedOn: quick play and ranked (2026-10-24) put them after reactions
      assert(JSON.stringify(keys) === JSON.stringify(OLD_FIELDS.concat(["features", "serverNow", "reactionsOn", "reactions", "ranked", "rankedModel", "rankedOn", "waiting", "waitPos"])), "state fields: " + keys);
      assert(Array.isArray(A.st.ranked) && A.st.ranked.length === 2 && A.st.ranked.every((r) => r && typeof r.rating === "number" && typeof r.label === "string" && r.provisional === true), "ranked: one small rating card a seat, provisional for two new players: " + JSON.stringify(A.st.ranked));
      assert(A.st.rankedModel === "openskill" && A.st.rankedOn === true, "rankedModel and rankedOn: a table of two people counts: " + A.st.rankedModel + " " + A.st.rankedOn);
      assert(A.st.features.includes("refusalCodes") && Math.abs(A.st.serverNow - Date.now()) < 2000, "features and serverNow");
      console.log("PASS today's app — old fields unchanged and first; features and serverNow after them");
    }
    // ---- GN-10
    {
      const [A, B] = await table(2);
      A.emit("start");
      await until(() => A.st.status === "playing");
      let checked = 0, stale = 0;
      for (let k = 0; k < 10 && A.st.status === "playing"; k++) {
        await sleep(250);
        const me = A.st.turn === A.seat ? A : B;
        const before = A.frames.length;
        move(me);
        await until(() => A.frames.length > before);
        await sleep(40);
        const f = A.frames[A.frames.length - 1].room;
        if (f.status !== "playing") break;
        checked++;
        const left = f.phaseEndsAt - f.serverNow;
        if (left < TURN - 100 || left > TURN + 5) stale++;
      }
      assert(checked >= 6 && stale === 0, `GN-10: ${stale} of ${checked} states after a move carried an old deadline`);
      console.log(`PASS GN-10 — ${checked} moves, each state already carried the new turn's full ${TURN} ms`);
    }
    // ---- GN-05
    {
      const A = open(); await until(() => A.connected);
      A.emit("join", { code: "ZZZZZZ", name: "A", playerId: pid() });
      await until(() => A.errs.length === 1 && A.refusals.length === 1);
      assert(A.errs[0].text === "No room with that code." && A.errs[0].meta.code === "not_found" && A.refusals[0].code === "not_found" && A.refusals[0].op === "join", "not_found");
      A.emit("create", { name: "<>", playerId: pid() });
      await until(() => A.errs.length === 2);
      assert(A.errs[1].meta.code === "name_required", "name_required");
      const [H] = await table(1);
      H.emit("start"); await until(() => H.errs.length === 1);
      assert(H.errs[0].meta.code === "not_enough_players", "not_enough_players");
      for (let i = 0; i < 5; i++) H.emit("addBot");
      await until(() => H.st.players.length === 6);
      A.emit("join", { code: H.joined, name: "A", playerId: pid() });
      await until(() => A.errs.length === 3);
      assert(A.errs[2].text === "Room is full (6)." && A.errs[2].meta.code === "full", "full");
      const [P, Q] = await table(2);
      P.emit("start"); await until(() => P.st.status === "playing");
      A.emit("join", { code: P.joined, name: "A", playerId: pid() });
      await until(() => A.errs.length === 4);
      assert(A.errs[3].meta.code === "started", "started");
      const me = P.st.turn === P.seat ? P : Q, other = me === P ? Q : P;
      other.emit("drop"); await until(() => other.errs.length === 1);
      assert(other.errs[0].meta.code === "not_your_drop" && other.errs[0].text === "You can only drop on your turn, before drawing.", "not_your_drop");
      me.emit("__test", { openTop: { s: "J", r: 0 } }); await sleep(100);
      me.emit("draw", { from: "open" }); await until(() => me.errs.length === 1);
      assert(me.errs[0].meta.code === "joker_from_open" && me.refusals[0].op === "draw", "joker_from_open");
      me.emit("__test", { openTop: { s: "S", r: 5 } }); await sleep(100);
      me.emit("draw", { from: "open" }); await until(() => me.st.phase === "discard");
      me.emit("discard", { id: me.st.pickedOpenId }); await until(() => me.errs.length === 2);
      assert(me.errs[1].meta.code === "picked_card", "picked_card");
      console.log("PASS GN-05 — refusal event and err's second argument: not_found, name_required, not_enough_players, full, started, not_your_drop, joker_from_open, picked_card");
    }
    // ---- GN-20 / GN-30
    {
      const fam = "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}";
      const [A, B] = await table(2);
      const first = A.joined;
      A.emit("create", { name: "Seventeen chars!!" + fam, playerId: pid(), avatar: fam });
      await until(() => A.codes.length === 2 && A.st.code === A.codes[1]);
      assert(A.st.players[0].name === "Seventeen chars!!" && A.st.players[0].avatar === fam, "GN-30");
      await until(() => B.st.players[0].connected === false);
      assert(B.st.players[0].connected === false, "the first room shows the player away");
      const heard = A.frames.length;
      B.emit("chat", { t: "hi" }); await until(() => B.st.chat.length === 1); await sleep(200);
      assert(A.frames.slice(heard).every((f) => f.room.code !== first), "no more of the first room's states");
      const C = open(), pc = pid(); await until(() => C.connected);
      C.emit("join", { code: A.codes[1], name: "Cy", playerId: pc }); await until(() => C.st && C.st.players.length === 2);
      const C2 = open(); await until(() => C2.connected);
      C2.emit("join", { code: A.codes[1], name: "Cy", playerId: pc }); await until(() => C2.st);
      C.disconnect(); await sleep(300);
      assert(C2.st.players[1].connected === true, "a rejoin survives its old socket");
      console.log("PASS GN-20 / GN-30 — one room per socket; rejoin survives its old socket; names cut between whole characters");
    }
    // ---- bot turns in slices: 40 busy bot rooms around one human table
    {
      const srvB = server(PORT_B, { BOT_MS: "2", TURN_MS: "60000" });
      try {
        await sleep(700);
        const url = "http://localhost:" + PORT_B;
        const hosts = [];
        for (let i = 0; i < 40; i++) hosts.push(open(url));
        await until(() => hosts.every((c) => c.connected));
        hosts.forEach((h, i) => { h.emit("create", { name: "B" + i, playerId: pid() }); });
        await until(() => hosts.every((h) => h.st));
        hosts.forEach((h) => { for (let k = 0; k < 5; k++) h.emit("addBot"); });
        await until(() => hosts.every((h) => h.st.players.length === 6));
        hosts.forEach((h) => { h.emit("drop"); });   // not in a game yet: harmless
        hosts.forEach((h) => { h.emit("start"); });
        await until(() => hosts.every((h) => h.st.status === "playing"));
        // the hosts play instantly and rematch at once: the bots never rest
        const keep = setInterval(() => hosts.forEach((h) => { const r = h.st; if (!r) return; if (r.status === "over") h.emit("rematch"); else if (r.turn === h.seat) move(h); }), 5);
        const [A, B] = await table(2, url);
        A.emit("start"); await until(() => A.st.status === "playing");
        const lat = [];
        for (let k = 0; k < 60 && A.st.status === "playing"; k++) {
          const me = A.st.turn === A.seat ? A : B;
          const got = new Promise((res) => { const t = setTimeout(() => res(null), 3000); me.once("state", () => { clearTimeout(t); res(performance.now()); }); });
          const t0 = performance.now();
          move(me);
          const t1 = await got;
          lat.push((t1 || performance.now()) - t0);
          await sleep(15);
        }
        clearInterval(keep);
        const botMoves = hosts.reduce((a, h) => a + h.frames.length, 0);
        lat.sort((x, y) => x - y);
        const p95 = lat[Math.floor(lat.length * 0.95) - 1], mx = lat[lat.length - 1];
        assert(lat.length >= 30 && p95 < 60 && mx < 250, `a human's move beside 40 busy bot rooms: p95 ${p95.toFixed(1)} ms, max ${mx.toFixed(1)} ms`);
        assert(botMoves > 2000, "the bot rooms kept playing (" + botMoves + " states)");
        console.log(`PASS bot queue — beside 40 all-bot rooms (${botMoves} states), a human's move p50 ${lat[Math.floor(lat.length / 2)].toFixed(1)} ms, p95 ${p95.toFixed(1)}, max ${mx.toFixed(1)}`);
      } finally { srvB.kill(); }
    }
    console.log("ALL WORLDS TESTS PASS");
    process.exitCode = 0;
  } catch (e) {
    console.error("FAIL:", e.message);
    process.exitCode = 1;
  } finally {
    socks.forEach((c) => c.close());
    srv.kill();
    setTimeout(() => process.exit(process.exitCode), 100);
  }
})();
