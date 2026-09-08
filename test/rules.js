/*
 Rummy — rules & secrecy suite.
 Part 1 (unit): meld validator, declare validator, points math, solver cross-check.
 Part 2 (sockets): BOT_MS=5 PORT=3411 node server.js   then:  node test/rules.js
 Proves: deal integrity, hand secrecy, draw/discard flow, open-pile discard
 block, arrange persistence, wrong-declare penalty, valid declare wins with
 correct points, reshuffle, rematch.
*/
const eng = require("../server.js");
const { io } = require("socket.io-client");
const URL = "http://localhost:3411";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let uid = 1000;
function C(str) { // "5S" "10H" "AS" "KD" "JK" (printed joker)
  if (str === "JK") return { id: uid++, s: "J", r: 0 };
  const m = str.match(/^(A|K|Q|J|10|[2-9])([SHDC])$/);
  const r = { A: 1, J: 11, Q: 12, K: 13 }[m[1]] || Number(m[1]);
  return { id: uid++, s: m[2], r };
}
const H = (...ss) => ss.map(C);
function assert(cond, msg) { if (!cond) throw new Error("UNIT FAIL: " + msg); }

function t11Unit() {
  const dw = (cards, wild) => eng.deadwood(cards, wild);
  // three hands
  assert(dw(H("4S", "5S", "6S", "9H", "9D", "9C", "KD", "2C"), 3) === 12, "deadwood: pure run + set leave K + 2 = 12");
  assert(dw(H("4S", "5S", "JK", "7H", "7D", "7C", "QS", "KS", "AS"), 3) === 0, "deadwood: joker-filled run + set + ace-high run = 0");
  assert(dw(H("5S", "6S", "7S", "8S", "5H", "5D"), 3) === 0, "deadwood: chooses set 5-5-5 + run 6-7-8 over the 4-run (0, not 10)");
  assert(dw(H("2S", "4S", "6S", "8H", "10H", "QH", "3D", "5D", "7D", "9C", "JC", "KC", "AC", "JK"), 9) === 35, "deadwood: two jokers (JK + wild 9C) placed where they meld the most (35)");
  // declare: every finish card is tried — here the only winning throws are 'useful' cards the old top-3 rule never reached
  const win13 = H("4S", "5S", "6S", "7H", "8H", "9H", "10C", "10D", "10S", "2D", "3D", "4D", "5D");
  const hand14 = win13.concat(H("10H"));   // 10H pairs with the tens → 'useful' → sorted last by the old heuristic
  const fin = eng.botFinishCard(hand14, 6, null);
  assert(fin, "declare: a finish card is found");
  const kept = hand14.filter((c) => c.id !== fin.id);
  assert(eng.validateDeclare(kept, fin.groups, 6).valid, "declare: the chosen finish leaves a valid declare");
  assert(eng.botFinishCard(H("2S", "4S", "6S", "8H", "10H", "QH", "3D", "5D", "7D", "9C", "JC", "KC", "AC", "JK"), 3, null) === null, "declare: no finish for a junk hand");
  const picked = hand14.find((c) => c.r === 10 && c.s === "H");
  assert(eng.botFinishCard(hand14, 6, picked.id) === null || eng.botFinishCard(hand14, 6, picked.id).id !== picked.id, "declare: never finishes with the card just picked up");
  // discard: lowest resulting deadwood, dumping the higher loose card on ties
  const d = eng.botDiscardCard(H("4S", "5S", "6S", "9H", "9D", "9C", "KD", "2C"), 3, null);
  assert(d.r === 13 && d.s === "D", "discard: throws the loose K, not a melded card (got " + d.r + d.s + ")");
  // open pile: only when it lowers deadwood
  assert(eng.botWantsOpen(H("4S", "5S", "9H", "KD", "2C"), C("6S"), 3) === true, "open pile: 6S completes 4-5-6 → take it");
  assert(eng.botWantsOpen(H("4S", "5S", "9H", "KD", "2C"), C("JD"), 3) === false, "open pile: JD helps nothing → leave it");
  assert(eng.botWantsOpen(H("4S", "5S", "9H", "KD", "2C"), C("JK"), 3) === false, "open pile: jokers are never taken (T7)");
  console.log("PASS T11 deadwood on four hands, finish card tried across the whole hand, discard by deadwood, open-pile only when it helps");
}

function unitTests() {
  t11Unit();
  const vm = (cards, wild) => eng.validMeld(cards, wild);
  // ---- pure sequences ----
  assert(vm(H("4S", "5S", "6S"), 9).type === "pure", "4-5-6 same suit pure");
  assert(vm(H("QS", "KS", "AS"), 9).type === "pure", "Q-K-A ace-high pure");
  assert(vm(H("AS", "2S", "3S"), 9).type === "pure", "A-2-3 ace-low pure");
  assert(vm(H("7H", "8H", "9H"), 7).type === "pure", "wildcard used as itself keeps a sequence PURE");
  assert(!vm(H("KS", "AS", "2S"), 9).valid, "K-A-2 wraparound invalid");
  assert(!vm(H("4S", "5S", "6H"), 9).valid, "mixed suit seq invalid");
  assert(!vm(H("4S", "5S"), 9).valid, "two cards invalid");
  // ---- impure sequences ----
  assert(vm(H("4S", "5S", "JK"), 9).type === "seq", "joker extends 4-5");
  assert(vm(H("4S", "6S", "JK"), 9).type === "seq", "joker fills 4-_-6");
  assert(vm(H("4S", "6S", "9D", "JK"), 9).type === "seq", "wild 9D acts as joker to fill/extend");
  assert(!vm(H("4S", "6S", "10S", "JK"), 9).valid, "one joker can't fill two holes");
  assert(vm(H("JK", "JK", "5D"), 9).type === "seq", "two jokers + one card is an impure seq");
  // ---- sets ----
  assert(vm(H("5S", "5H", "5D"), 9).type === "set", "three suits set");
  assert(vm(H("5S", "5H", "5D", "5C"), 9).type === "set", "four suits set");
  assert(!vm(H("5S", "5H", "5S"), 9).valid, "duplicate suit in set invalid");
  assert(vm(H("5S", "5H", "JK"), 9).type === "set", "joker completes a set");
  assert(vm(H("5S", "5H", "9D"), 9).type === "set", "wild 9 completes a set");
  assert(!vm(H("5S", "5H", "5D", "5C", "JK"), 9).valid, "5-card set invalid");

  // ---- declare validation ----
  const wild = 9;
  const good = [H("AS", "2S", "3S"), H("5H", "6H", "7H"), H("10D", "JD", "QD", "KD"), H("4S", "4H", "4D")];
  const hand13 = good.flat();
  const groups = good.map((g) => g.map((c) => c.id));
  assert(eng.validateDeclare(hand13, groups, wild).valid, "textbook declare is valid");

  // no pure sequence (both seqs use jokers)
  const np = [H("AS", "2S", "JK"), H("5H", "6H", "JK"), H("10D", "JD", "QD", "KD"), H("4S", "4H", "4D")];
  // make second "pure" seq impure: 10D JD QD KD is pure — replace with a jokered one
  const np2 = [H("AS", "2S", "JK"), H("5H", "6H", "JK"), H("10D", "JD", "QD", "JK"), H("4S", "4H", "4D")];
  assert(!eng.validateDeclare(np2.flat(), np2.map((g) => g.map((c) => c.id)), wild).valid, "declare without a pure sequence invalid");

  // only one sequence
  const oneSeq = [H("AS", "2S", "3S"), H("5H", "5S", "5D"), H("10D", "10H", "10S", "10C"), H("4S", "4H", "4D")];
  assert(!eng.validateDeclare(oneSeq.flat(), oneSeq.map((g) => g.map((c) => c.id)), wild).valid, "declare with one sequence invalid");

  // ungrouped card
  const short = groups.slice(0, 3);
  assert(!eng.validateDeclare(hand13, short, wild).valid, "leftover cards invalid");
  // card used twice
  const dup = groups.map((g) => g.slice());
  dup[3] = [groups[0][0], groups[3][1], groups[3][2]];
  assert(!eng.validateDeclare(hand13, dup, wild).valid, "reused card invalid");
  // foreign card
  const foreign = groups.map((g) => g.slice());
  foreign[3] = [99999, foreign[3][1], foreign[3][2]];
  assert(!eng.validateDeclare(hand13, foreign, wild).valid, "foreign card invalid");

  // ---- points ----
  assert(eng.cardPoints(C("AS"), 9) === 10, "ace 10 pts");
  assert(eng.cardPoints(C("KD"), 9) === 10, "king 10 pts");
  assert(eng.cardPoints(C("10H"), 9) === 10, "ten 10 pts");
  assert(eng.cardPoints(C("6C"), 9) === 6, "six 6 pts");
  assert(eng.cardPoints(C("JK"), 9) === 0, "printed joker 0 pts");
  assert(eng.cardPoints(C("9C"), 9) === 0, "wildcard card 0 pts");

  // scoreHand: with pure + 2nd seq, only deadwood counts
  const partial = [H("AS", "2S", "3S"), H("5H", "6H", "7H")];
  const dead = H("KD", "QD", "9C", "4S", "4H", "8C", "2D"); // 9C wild = 0 -> 10+10+0+4+4+8+2 = 38
  const hand = partial.flat().concat(dead);
  const pgroups = partial.map((g) => g.map((c) => c.id));
  assert(eng.scoreHand(hand, pgroups, 9) === 38, "deadwood-only scoring, got " + eng.scoreHand(hand, pgroups, 9));
  // no pure sequence: everything non-joker counts
  const noPure = H("KD", "KS", "KH", "QD", "QS", "QH", "10D", "10S", "10H", "AD", "AS", "AH", "9C");
  assert(eng.scoreHand(noPure, [], 9) === 80, "full count capped at 80");
  const smallHand = H("2D", "3C", "4H");
  assert(eng.scoreHand(smallHand, [], 9) === 9, "small full count exact");

  // ---- solver cross-check: any solver win must pass the declare validator ----
  const deck = eng.buildDeck();
  let wins = 0;
  for (let t = 0; t < 400; t++) {
    const d = deck.slice();
    for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; }
    const cards = d.slice(0, 13);
    const wr = 1 + Math.floor(Math.random() * 13);
    const win = eng.bestArrangement(cards, wr, 30000);
    if (win) {
      wins++;
      const v = eng.validateDeclare(cards, win.groups, wr);
      assert(v.valid, "solver arrangement failed validator: " + JSON.stringify(win.groups));
    }
  }
  // sanity: solver must find a win on a crafted winning hand
  const crafted = [H("AS", "2S", "3S"), H("5H", "6H", "7H"), H("10D", "JD", "QD", "KD"), H("4S", "4H", "4D")].flat();
  assert(eng.bestArrangement(crafted, 9, 30000), "solver finds crafted win");
  const craftedWild = [H("AS", "2S", "3S"), H("5H", "6H", "JK"), H("10D", "JD", "QD", "KD"), H("4S", "4H", "9C")].flat();
  assert(eng.bestArrangement(craftedWild, 9, 30000), "solver finds crafted win with jokers");
  console.log(`PASS unit — melds, declares, points, solver cross-check (${wins}/400 random hands winnable)`);
}

/* ================= socket tests ================= */
function mk(name) {
  const s = io(URL, { transports: ["websocket"] });
  s.nm = name; s.st = null; s.seat = -1; s.leaks = [];
  s.on("state", ({ room, mySeat }) => {
    s.st = room; s.seat = mySeat;
    for (let i = 0; i < room.players.length; i++) {
      const p = room.players[i];
      for (const k of Object.keys(p)) if (["hand", "cards", "yourHand", "groups"].includes(k)) s.leaks.push("player field " + k);
      if (typeof p.count !== "number") s.leaks.push("missing count");
    }
    if (room.yourHand && mySeat >= 0 && room.players[mySeat] && room.yourHand.length !== room.players[mySeat].count)
      s.leaks.push("own hand/count mismatch");
  });
  return s;
}
const myTurn = (c) => c.st && c.st.status === "playing" && c.seat === c.st.turn;

async function until(fn, cap, why) {
  for (let k = 0; k < cap; k++) { if (fn()) return true; await sleep(12); }
  throw new Error("timeout: " + why);
}

(async () => {
  try {
    unitTests();

    /* ---- Test A: 3 humans — deal, secrecy, flow, open-pile block, arrange, wrong declare ---- */
    const cs = [mk("A"), mk("B"), mk("C")];
    await sleep(300);
    let code = null; cs[0].on("joined", (j) => { code = j.code; });
    cs[0].emit("create", { name: "A", playerId: "r0", avatar: "🦊" }); await sleep(250);
    for (let i = 1; i < 3; i++) cs[i].emit("join", { code, name: "P" + i, playerId: "r" + i, avatar: "🐼" });
    await sleep(300);
    cs[0].emit("start"); await sleep(350);
    const r0 = cs[0].st;
    if (r0.players.reduce((a, p) => a + p.count, 0) !== 39) throw new Error("deal wrong: " + r0.players.map((p) => p.count));
    if (!r0.wildCard || !r0.wildRank) throw new Error("no wildcard");
    if (r0.openTop.length !== 1) throw new Error("open pile should start with 1 card");
    if (r0.closedCount !== 106 - 39 - 1 - 1) throw new Error("closed count wrong: " + r0.closedCount);
    for (const c of cs) if (c.st.yourHand.length !== 13) throw new Error(c.nm + " hand != 13");

    // flow: current player draws open, may not discard it back
    let cur = cs.find((c) => myTurn(c));
    const openId = cur.st.openTop[cur.st.openTop.length - 1].id;
    cur.emit("draw", { from: "open" });
    await until(() => cur.st.phase === "discard" && cur.st.yourHand.length === 14, 200, "draw open");
    if (cur.st.pickedOpenId !== openId) throw new Error("pickedOpenId not reported");
    cur.emit("discard", { id: openId }); await sleep(150);
    if (cur.st.phase !== "discard") throw new Error("discarding the picked-up card was allowed");
    const other = cur.st.yourHand.find((c) => c.id !== openId);
    cur.emit("discard", { id: other.id });
    await until(() => cur.st.yourHand.length === 13 && cur.st.turn !== cur.seat, 200, "discard advance");
    console.log("PASS deal + secrecy + open-pile discard block");

    // arrange persists
    const arr = cs[1];
    const g0 = arr.st.yourHand.slice(0, 3).map((c) => c.id);
    const g1 = arr.st.yourHand.slice(3, 6).map((c) => c.id);
    arr.emit("arrange", { groups: [g0, g1] });
    await until(() => arr.st.yourGroups.length === 2 && arr.st.yourGroups[0].join() === g0.join(), 200, "arrange persist");
    // hostile arrange: foreign + duplicate ids get stripped
    arr.emit("arrange", { groups: [[999999, g0[0], g0[0], g0[1]]] });
    await until(() => arr.st.yourGroups.length === 1 && arr.st.yourGroups[0].join() === [g0[0], g0[1]].join(), 200, "hostile arrange cleaned");
    console.log("PASS arrange persistence + hostile arrange");

    // wrong declare: whoever is on turn declares all-cards-one-group
    cur = cs.find((c) => myTurn(c));
    cur.emit("draw", { from: "closed" });
    await until(() => cur.st.phase === "discard", 200, "draw for wrong declare");
    const all = cur.st.yourHand.map((c) => c.id);
    cur.emit("declare", { discardId: all[0], groups: [all.slice(1)] });
    await until(() => cur.st.players[cur.seat].out, 300, "wrong declarer marked out");
    if (cur.st.status !== "playing") throw new Error("game should continue after wrong declare (3 players)");
    if (cur.st.turn === cur.seat) throw new Error("turn stuck on out player");
    console.log("PASS wrong declare — 80, out, game continues");

    // remaining two: leave one -> last standing wins, results carry 80 for wrong declarer
    const alive = cs.filter((c) => !c.st.players[c.seat].out);
    alive[0].emit("leave");
    await until(() => alive[1].st && alive[1].st.status === "over", 300, "last standing");
    const res = alive[1].st.results;
    if (!res) throw new Error("no results");
    const wrongRow = res.find((x) => x.seat === cur.seat);
    if (!wrongRow || wrongRow.points !== 80) throw new Error("wrong declarer not scored 80");
    if (alive[1].st.winner !== alive[1].seat) throw new Error("last standing not winner");
    for (const c of cs) if (c.leaks.length) throw new Error(c.nm + " leak: " + c.leaks[0]);
    console.log("PASS last-standing + results include the 80");
    cs.forEach((c) => c.close());

    /* ---- Test B: reshuffle — 2 humans cycle draw-closed/discard-drawn ---- */
    const A = mk("A2"), B = mk("B2"); await sleep(250);
    let c2 = null; A.on("joined", (j) => { c2 = j.code; });
    A.emit("create", { name: "A2", playerId: "ra2", avatar: "🦊" }); await sleep(250);
    B.emit("join", { code: c2, name: "B2", playerId: "rb2", avatar: "🐼" }); await sleep(250);
    A.emit("start"); await sleep(300);
    let sawLow = false, sawRefill = false, prevClosed = A.st.closedCount;
    for (let k = 0; k < 4000; k++) {
      const me = [A, B].find((c) => myTurn(c));
      if (me) {
        if (me.st.phase === "draw") me.emit("draw", { from: "closed" });
        else {
          // discard the newest card that isn't blocked
          const hand = me.st.yourHand;
          const pick = hand[hand.length - 1];
          me.emit("discard", { id: pick.id });
        }
      }
      await sleep(6);
      const st = A.st;
      if (st && st.closedCount <= 2) sawLow = true;
      if (sawLow && st && st.closedCount > prevClosed + 10) { sawRefill = true; break; }
      if (st) prevClosed = st.closedCount;
    }
    if (!sawLow) throw new Error("closed pile never ran low");
    if (!sawRefill) throw new Error("reshuffle never refilled the closed pile");
    console.log("PASS reshuffle — closed pile refilled from discards");
    A.emit("leave"); B.emit("leave"); A.close(); B.close();

    /* ---- Test C: solver-assisted humans play to a REAL valid declare, then rematch ---- */
    const X = mk("X"), Y = mk("Y"); await sleep(250);
    let c3 = null; X.on("joined", (j) => { c3 = j.code; });
    X.emit("create", { name: "X", playerId: "rx", avatar: "🦊" }); await sleep(250);
    Y.emit("join", { code: c3, name: "Y", playerId: "ry", avatar: "🐼" }); await sleep(250);
    X.emit("start"); await sleep(300);

    async function smartTurn(me) {
      const st = me.st;
      if (st.phase === "draw") {
        // take the open card if it makes the 14-card hand winnable, else closed
        me.emit("draw", { from: Math.random() < 0.25 ? "open" : "closed" });
        return;
      }
      const hand = st.yourHand;
      for (const cand of hand) {
        if (cand.id === st.pickedOpenId) continue;
        const kept = hand.filter((c) => c.id !== cand.id);
        const win = eng.bestArrangement(kept, st.wildRank, 15000);
        if (win) { me.emit("declare", { discardId: cand.id, groups: win.groups }); return; }
      }
      // discard highest-point non-useful card
      const scored = hand.filter((c) => c.id !== st.pickedOpenId)
        .map((c) => ({ c, p: eng.cardPoints(c, st.wildRank) }))
        .sort((a, b) => b.p - a.p);
      me.emit("discard", { id: scored[0].c.id });
    }
    let done = false;
    for (let k = 0; k < 6000; k++) {
      if (X.st && X.st.status === "over") { done = true; break; }
      const me = [X, Y].find((c) => myTurn(c));
      if (me) await smartTurn(me);
      await sleep(8);
    }
    if (!done) throw new Error("solver game never finished");
    const fin = X.st;
    if (fin.winner == null) throw new Error("no winner");
    const wres = fin.results.find((x) => x.seat === fin.winner);
    const lres = fin.results.find((x) => x.seat !== fin.winner);
    if (wres.points !== 0) throw new Error("winner should score 0");
    if (!(lres.points >= 0 && lres.points <= 80)) throw new Error("loser points out of range: " + lres.points);
    if (fin.results[0].seat !== fin.winner) throw new Error("results not sorted, winner first");
    console.log(`PASS valid declare wins — winner 0 pts, loser ${lres.points} pts`);

    // rematch
    const host = [X, Y].find((c) => c.seat === c.st.hostSeat);
    host.emit("rematch");
    await until(() => X.st.status === "playing" && X.st.yourHand.length === 13 && Y.st.yourHand.length === 13, 300, "rematch redeal");
    console.log("PASS rematch — fresh deal of 13");
    for (const c of [X, Y]) if (c.leaks.length) throw new Error(c.nm + " leak: " + c.leaks[0]);
    X.close(); Y.close();

    /* ---- Test D: host + bot game (bots draw/discard, may declare only validly) ---- */
    const Hh = mk("H"); await sleep(250);
    let c4 = null; Hh.on("joined", (j) => { c4 = j.code; });
    Hh.emit("create", { name: "Host", playerId: "rh", avatar: "🦊" }); await sleep(250);
    Hh.emit("addBot"); await sleep(250);
    Hh.emit("start"); await sleep(300);
    // human mirrors the solver strategy; bot plays itself
    let overD = false;
    for (let k = 0; k < 6000; k++) {
      if (Hh.st && Hh.st.status === "over") { overD = true; break; }
      if (myTurn(Hh)) await smartTurnH(Hh);
      await sleep(8);
    }
    async function smartTurnH(me) {
      const st = me.st;
      if (st.phase === "draw") { me.emit("draw", { from: "closed" }); return; }
      const hand = st.yourHand;
      for (const cand of hand) {
        if (cand.id === st.pickedOpenId) continue;
        const kept = hand.filter((c) => c.id !== cand.id);
        const win = eng.bestArrangement(kept, st.wildRank, 15000);
        if (win) { me.emit("declare", { discardId: cand.id, groups: win.groups }); return; }
      }
      const scored = hand.filter((c) => c.id !== st.pickedOpenId)
        .map((c) => ({ c, p: eng.cardPoints(c, st.wildRank) })).sort((a, b) => b.p - a.p);
      me.emit("discard", { id: scored[0].c.id });
    }
    if (!overD) throw new Error("bot game stalled");
    if (Hh.st.winner == null) throw new Error("bot game no winner");
    console.log("PASS bot game to completion — winner: " + Hh.st.players[Hh.st.winner].name);
    Hh.close();

    /* ---- Test E (T1 AFK policy): own fast-clock server on 3421 ---- */
    {
      const { spawn } = require("child_process");
      const TURN = 700, AFK = 250, P = 3421, URL2 = "http://localhost:" + P;
      const srv = spawn(process.execPath, ["server.js"], { env: { ...process.env, PORT: String(P), TURN_MS: String(TURN), AFK_MS: String(AFK), BOT_MS: "5", TEST_HOOKS: "1" }, stdio: "ignore" });
      await sleep(600);
      const mk2 = (name) => { const c = io(URL2, { transports: ["websocket"], reconnection: false }); c.nm = name; c.st = null; c.seat = -1; c.logs = []; c.on("state", ({ room, mySeat }) => { c.st = room; c.seat = mySeat; if (room && room.log) c.logs.push(room.log); }); return c; };
      const wait = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(15); } return false; };
      const room2 = async () => { const A = mk2("A"), B = mk2("B"); let code = null; A.on("joined", (j) => { code = j.code; }); await sleep(200); A.emit("create", { name: "A", playerId: "afkA" + Math.random(), avatar: "🦊" }); await wait(() => code, 2000); B.emit("join", { code, name: "B", playerId: "afkB" + Math.random(), avatar: "🐼" }); await wait(() => B.st && B.st.players.length === 2, 2000); A.emit("start"); await wait(() => A.st && A.st.status === "playing", 2000); return { A, B }; };
      const driveH = (me) => { const st = me.st; if (!st || st.status !== "playing" || st.turn !== me.seat) return; if (st.phase === "draw") { me.emit("draw", { from: "closed" }); return; } const hand = st.yourHand; for (const cand of hand) { if (cand.id === st.pickedOpenId) continue; const win = eng.bestArrangement(hand.filter((c) => c.id !== cand.id), st.wildRank, 8000); if (win) { me.emit("declare", { discardId: cand.id, groups: win.groups }); return; } } const scored = hand.filter((c) => c.id !== st.pickedOpenId).map((c) => ({ c, p: eng.cardPoints(c, st.wildRank) })).sort((a, b) => b.p - a.p); me.emit("discard", { id: scored[0].c.id }); };
      try {
        // E1: the current player disconnects → the turn is auto-played on the AFK clock
        { const { A, B } = await room2(); const first = A.st.turn; const gone = first === 0 ? A : B, W = first === 0 ? B : A; gone.disconnect(); const t0 = Date.now();
          if (!(await wait(() => W.st && W.st.turn !== first, TURN + 800))) throw new Error("AFK: disconnected player's turn was not auto-played"); const dt = Date.now() - t0; if (dt >= TURN) throw new Error("AFK: fired on the normal clock (" + dt + " ms)");
          if (!(await wait(() => W.logs.some((l) => /played for them/.test(l)), 600))) throw new Error("AFK: no timeout note");
          console.log("PASS AFK 5s clock — auto-played after " + dt + " ms (normal " + TURN + ")"); W.disconnect(); }
        // E2: idle but connected: 3 timeouts → botControlled; takeSeat and a real action hand it back
        { const { A, B } = await room2();
          // junk hands for both seats so neither the driver nor the (now much smarter) bot can end the game before the third timeout
          const junk = (sfx) => [[2,"S"],[4,"S"],[6,"S"],[8,"H"],[10,"H"],[12,"H"],[3,"D"],[5,"D"],[7,"D"],[9,"C"],[11,"C"],[13,"C"],[1,sfx]].map(([r,su])=>({ r, s: su }));
          A.emit("__test", { hands: { [A.seat]: junk("D"), [B.seat]: junk("H") } }); await wait(() => A.st.yourHand.length === 13 && A.st.yourHand.every((c) => c.r !== 6 || c.s === "S"), 1500);
          A.on("state", () => setTimeout(() => driveH(A), 10)); const idle = B.seat;
          if (!(await wait(() => B.st && B.st.players[idle].botControlled, TURN * 9))) throw new Error("AFK: seat never became botControlled");
          if (B.st.players[idle].bot || B.st.players[idle].name !== "B") throw new Error("AFK: seat identity changed");
          if (!(await wait(() => B.logs.some((l) => /playing for B/.test(l)), 500))) throw new Error("AFK: no takeover log");
          B.emit("takeSeat"); if (!(await wait(() => !B.st.players[idle].botControlled, 1500))) throw new Error("AFK: takeSeat did not clear the flag");
          if (!(await wait(() => B.st.players[idle].botControlled, TURN * 9))) throw new Error("AFK: seat did not flip a second time");
          B.emit("draw", { from: "closed" }); if (!(await wait(() => !B.st.players[idle].botControlled, 1500))) throw new Error("AFK: a human action did not clear the flag");
          console.log("PASS AFK takeover after 3 timeouts, takeSeat + action hand it back"); A.disconnect(); B.disconnect(); }
        // E3: a bot-controlled seat completes a whole game
        { const { A, B } = await room2(); A.on("state", () => setTimeout(() => driveH(A), 5)); const idle = B.seat; B.disconnect();
          if (!(await wait(() => A.st && A.st.status === "over", 90000))) throw new Error("AFK: game with a bot-controlled seat stalled");
          if (!A.st.players[idle].botControlled) throw new Error("AFK: absent seat never became bot-controlled");
          console.log("PASS AFK bot-controlled seat finished a full game — winner " + A.st.players[A.st.winner].name); A.disconnect(); }
      } finally { srv.kill(); }
    }


    // ---- T3 host handover: host disconnects during play → another human becomes host ----
    {
      const { spawn } = require("child_process");
      const P=3431, URL2="http://localhost:"+P;
      const srv = spawn(process.execPath, ["server.js"], { env: { ...process.env, PORT:String(P), BOT_MS:"5", TURN_MS:"60000" }, stdio:"ignore" });
      await sleep(600);
      const mk2=(name)=>{ const c=io(URL2,{transports:["websocket"],reconnection:false}); c.st=null; c.seat=-1; c.logs=[]; c.on("state",({room,mySeat})=>{ c.st=room; c.seat=mySeat; if(room&&room.log) c.logs.push(room.log); }); return c; };
      const wait=async(fn,ms=6000)=>{ const t0=Date.now(); while(Date.now()-t0<ms){ if(fn()) return true; await sleep(15);} return false; };
      try {
        const n=2; const cs=[]; for(let i=0;i<n;i++) cs.push(mk2("H"+i)); await sleep(250); let code=null; cs[0].on("joined",j=>{code=j.code;});
        cs[0].emit("create",{name:"H0",playerId:"h0"+Math.random(),avatar:"🦊"}); await wait(()=>code); for(let i=1;i<n;i++) cs[i].emit("join",{code,name:"H"+i,playerId:"h"+i+Math.random(),avatar:"🐼"}); await wait(()=>cs[0].st&&cs[0].st.players.length===n);
        
        cs[0].emit("start"); if(!(await wait(()=>cs[1].st&&cs[1].st.status==="playing"))) throw new Error("T3: game did not start");
        if(cs[1].st.hostSeat!==cs[0].seat) throw new Error("T3: creator is not the host at start");
        cs[0].disconnect();
        if(!(await wait(()=>cs[1].st.hostSeat===cs[1].seat, 3000))) throw new Error("T3: host did not move to the connected human (hostSeat "+cs[1].st.hostSeat+")");
        if(!cs[1].logs.some(l=>/is now the host/.test(l))) throw new Error("T3: no host log line");
        console.log("PASS T3 host handover — host disconnected mid-game, next connected human is host");
        
        cs.forEach(c=>c.disconnect());
      } finally { srv.kill(); }
    }
    /* ---- Test F (T7): no joker pickup from the open pile, drop 20/40, leaving costs 40 ---- */
    {
      const { spawn } = require("child_process");
      const P = 3431, URL2 = "http://localhost:" + P;
      const srv = spawn(process.execPath, ["server.js"], { env: { ...process.env, PORT: String(P), BOT_MS: "5", TEST_HOOKS: "1" }, stdio: "ignore" });
      await sleep(600);
      const mk2 = (name) => { const c = io(URL2, { transports: ["websocket"], reconnection: false }); c.nm = name; c.st = null; c.seat = -1; c.errs = []; c.on("state", ({ room, mySeat }) => { c.st = room; c.seat = mySeat; }); c.on("err", (m) => c.errs.push(m)); return c; };
      const wait = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(15); } return false; };
      const boot = async (n) => { const cs = []; for (let i = 0; i < n; i++) cs.push(mk2("F" + i)); await sleep(250); let code = null; cs[0].on("joined", (j) => { code = j.code; }); cs[0].emit("create", { name: "F0", playerId: "f0" + Math.random(), avatar: "🦊" }); await wait(() => code, 2000); for (let i = 1; i < n; i++) cs[i].emit("join", { code, name: "F" + i, playerId: "f" + i + Math.random(), avatar: "🐼" }); await wait(() => cs[0].st && cs[0].st.players.length === n, 2000); cs[0].emit("start"); await wait(() => cs.every((c) => c.st && c.st.status === "playing" && c.st.yourHand.length === 13), 2000); return cs; };
      const onTurn = (cs) => cs.find((c) => c.st.turn === c.seat);
      const drawDiscard = async (c) => { c.emit("draw", { from: "closed" }); await wait(() => c.st.phase === "discard" && c.st.turn === c.seat, 1500); const id = c.st.yourHand.find((x) => x.id !== c.st.pickedOpenId).id; c.emit("discard", { id }); await wait(() => c.st.turn !== c.seat, 1500); };
      try {
        // joker on top of the open pile: printed joker, then a wildcard-rank card
        const cs = await boot(3);
        for (const jk of [{ s: "J", r: 0 }, { s: "S", r: cs[0].st.wildRank === 1 ? 1 : cs[0].st.wildRank }]) {
          const cur = onTurn(cs); const v = cur.st.v;
          cur.emit("__test", { openTop: jk }); await wait(() => cur.st.openTop[cur.st.openTop.length - 1].s === jk.s && cur.st.openTop[cur.st.openTop.length - 1].r === jk.r, 1500);
          const n = cur.errs.length; cur.emit("draw", { from: "open" });
          if (!(await wait(() => cur.errs.length > n, 1500))) throw new Error("T7: no error when picking a joker from the open pile");
          if (cur.st.phase !== "draw" || cur.st.yourHand.length !== 13) throw new Error("T7: joker was picked up from the open pile");
          if (!/joker/i.test(cur.errs[n])) throw new Error("T7: unexpected error text: " + cur.errs[n]);
          await drawDiscard(cur);   // move on: closed draw still works with the joker sitting on top
        }
        console.log("PASS T7 jokers (printed + wildcard rank) can't be picked up from the open pile");
        cs.forEach((c) => c.close());
        // first-turn drop = 20 (player who has not drawn yet), middle drop = 40 (player who already drew); fresh rooms for exactness
        { const r = await boot(3); const cur = onTurn(r); cur.emit("drop"); if (!(await wait(() => cur.st.players[cur.seat].out && cur.st.turn !== cur.seat, 1500))) throw new Error("T7: first-turn drop not applied");
          const other = onTurn(r); const third = r.find((c) => c !== cur && c !== other);
          // dropping when it is not your turn / not the draw phase is refused
          const n = third.errs.length; third.emit("drop"); await wait(() => third.errs.length > n, 800); if (third.st.players[third.seat].out) throw new Error("T7: drop accepted off-turn");
          other.emit("draw", { from: "closed" }); await wait(() => other.st.phase === "discard", 1500);
          const n2 = other.errs.length; other.emit("drop"); await wait(() => other.errs.length > n2, 800); if (other.st.players[other.seat].out) throw new Error("T7: drop accepted after drawing");
          const id = other.st.yourHand.find((x) => x.id !== other.st.pickedOpenId).id; other.emit("discard", { id }); await wait(() => other.st.turn === third.seat, 1500);
          third.emit("leave"); if (!(await wait(() => other.st.status === "over", 1500))) throw new Error("T7: game did not end when the last opponent left");
          const res = other.st.results; const dropRow = res.find((x) => x.seat === cur.seat), leftRow = res.find((x) => x.seat === third.seat);
          if (!dropRow || dropRow.points !== 20 || !dropRow.dropped) throw new Error("T7: first-turn drop should score 20: " + JSON.stringify(dropRow));
          if (!leftRow || leftRow.points !== 40 || !leftRow.left) throw new Error("T7: leaving mid-game should score 40: " + JSON.stringify(leftRow));
          console.log("PASS T7 first-turn drop = 20, off-turn/after-draw drop refused, leaving mid-game = 40"); r.forEach((c) => c.close()); }
        { const r = await boot(3); const cur = onTurn(r); await drawDiscard(cur);   // cur has drawn once → its next drop is a middle drop
          let guard = 0; while (onTurn(r) !== cur && guard++ < 4) await drawDiscard(onTurn(r));
          if (onTurn(r) !== cur) throw new Error("T7: turn never came back");
          cur.emit("drop"); if (!(await wait(() => cur.st.players[cur.seat].out, 1500))) throw new Error("T7: middle drop not applied");
          const rest = r.filter((c) => c !== cur); rest[0].emit("leave"); await wait(() => rest[1].st.status === "over", 1500);
          const row = rest[1].st.results.find((x) => x.seat === cur.seat);
          if (!row || row.points !== 40 || !row.dropped) throw new Error("T7: middle drop should score 40: " + JSON.stringify(row));
          console.log("PASS T7 middle drop = 40"); r.forEach((c) => c.close()); }
      } finally { srv.kill(); }
    }
    console.log("ALL RUMMY TESTS PASS");
    process.exit(0);
  } catch (e) { console.error("FAIL:", e.message); process.exit(1); }
})();
