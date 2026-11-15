/* Rummy: the bots' three levels (2026-11-13), settings.botLevel = easy | normal | sharp: node test/botlevels.js.

   Part 1 plays tables of bots only, here, by the server's own rules and with a seed (test/botsim.js): sharp beats
   normal and normal beats easy over 2,000 deals each, and no level ever makes a move the server would turn away or
   leaves a deal unfinished. It also holds each level to what it is: normal is the bot as it has always played, easy
   declares a turn late and never drops, sharp drops only a hopeless first hand in a pool game and loses with its hand
   grouped. And the finish search no longer hangs on a hand full of jokers, with the same answers as before.

   Part 2 is over the wire, on servers of its own (TEST_PORT, default 5576, and TEST_PORT2, default 5577; never
   3111-3126): the setting is the host's and the lobby's, a room at normal sends exactly what it always sent, quick play
   keeps the normal bots, a game with easy or sharp bots is not rated, and whole games at each level end by themselves. */
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { io } = require("socket.io-client");
const eng = require("../server.js");
const Sim = require("./botsim.js");
const Bots = Sim.Bots;

const PORT = Number(process.env.TEST_PORT || 5576), PORT2 = Number(process.env.TEST_PORT2 || 5577);
for (const p of [PORT, PORT2]) if (p >= 3111 && p <= 3126) { console.error("refusing " + p + ": 3111-3126 are the live servers"); process.exit(2); }
const DEALS = Number(process.env.BOT_DEALS || 2000);   // the proof is 2,000 deals; a smaller number is only for a quick look
const SEED = 20261113;
const MARGIN = 0.55;   // "a clear margin": at least 55 deals in 100 (measured: about 59)

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const pending = [];
function test(name, fn) { pending.push([name, fn]); }
async function runAll() {
  for (const [name, fn] of pending) {
    try { await fn(); passed++; console.log("  ok " + name); }
    catch (e) { failed++; console.log("  FAILED " + name + "\n     " + ((e && e.stack) || e)); }
  }
}

let uid = 500000;
const card = (t) => ({ id: uid++, s: t[0], r: Number(t.slice(1)) });   // "H7", "S13", "J0" (a printed joker)
const cards = (s) => s.split(" ").map(card);
const text = (c) => c.s + c.r;
const share = (t, a, b) => t.wins[a] / Math.max(1, t.wins[a] + t.wins[b]);
const pct = (x) => (100 * x).toFixed(1) + "%";
/* A table as bots.js is handed it, for one seat. */
function tableOf(hand, wildRank, more = {}) {
  const seats = more.seats || 2;
  return Object.assign({ seat: 0, hand, wildRank, wildCard: { id: 1, s: "C", r: wildRank }, top: null, open: [], pickedOpenId: null,
    mem: Bots.memory(seats), next: 1, firstTurn: false, pool: false, poolLeft: null, active: seats, rnd: Sim.rngOf(7) }, more);
}

/* ------------------------------------------------------------------ part 1: bots only, seeded */

test(`sharp beats normal over ${DEALS} deals, no illegal move, no deal left unfinished`, () => {
  const t = Sim.match("sharp", "normal", DEALS, SEED);
  console.log(`     sharp ${t.wins.sharp} (${pct(share(t, "sharp", "normal"))}), normal ${t.wins.normal}; points a deal: sharp ${(t.points.sharp / t.deals).toFixed(1)}, normal ${(t.points.normal / t.deals).toFixed(1)}; longest deal ${t.maxTurns} turns`);
  assert.deepStrictEqual(t.illegal, [], "no illegal move");
  assert.strictEqual(t.unfinished, 0, "every deal ends");
  assert.strictEqual(t.deals, DEALS);
  assert.ok(share(t, "sharp", "normal") >= MARGIN, `sharp wins ${pct(share(t, "sharp", "normal"))} of the deals: not a clear margin`);
  assert.ok(t.points.sharp < t.points.normal, "and pays fewer points for the deals it loses");
});

test(`normal beats easy over ${DEALS} deals, no illegal move, no deal left unfinished`, () => {
  const t = Sim.match("normal", "easy", DEALS, SEED);
  console.log(`     normal ${t.wins.normal} (${pct(share(t, "normal", "easy"))}), easy ${t.wins.easy}; longest deal ${t.maxTurns} turns`);
  assert.deepStrictEqual(t.illegal, [], "no illegal move");
  assert.strictEqual(t.unfinished, 0, "every deal ends");
  assert.strictEqual(t.deals, DEALS);
  assert.ok(share(t, "normal", "easy") >= MARGIN, `normal wins ${pct(share(t, "normal", "easy"))} of the deals: not a clear margin`);
  assert.strictEqual(t.drops.easy + t.drops.normal, 0, "neither ever drops");
});

test("sharp beats easy by more than it beats normal", () => {
  const n = Math.min(DEALS, 600);
  const t = Sim.match("sharp", "easy", n, SEED + 5000);
  console.log(`     sharp ${t.wins.sharp} (${pct(share(t, "sharp", "easy"))}), easy ${t.wins.easy}`);
  assert.deepStrictEqual(t.illegal, []);
  assert.strictEqual(t.unfinished, 0);
  assert.ok(share(t, "sharp", "easy") >= 0.62, `sharp wins ${pct(share(t, "sharp", "easy"))} against easy`);
});

test("each level against itself, and tables of three to six with the levels mixed: every deal ends, every move is legal", () => {
  const n = Math.min(DEALS, 300);
  for (const lv of Bots.LEVELS) {
    const t = Sim.match(lv, lv, n, SEED + 9000);
    assert.deepStrictEqual(t.illegal, [], lv + " against itself");
    assert.strictEqual(t.unfinished, 0, lv + " against itself: every deal ends");
  }
  const tables = [["sharp", "normal", "easy"], ["easy", "easy", "sharp", "normal"], ["sharp", "sharp", "sharp", "sharp"],
    ["normal", "easy", "sharp", "easy", "normal"], ["easy", "normal", "sharp", "sharp", "normal", "easy"]];
  let deals = 0, drops = 0;
  for (const lv of tables) for (let k = 0; k < n / 2; k++) {
    for (const pool of [false, true]) {
      const r = Sim.playDeal(lv, SEED + 12000 + k, { pool, poolLeft: 60 });
      deals++;
      assert.deepStrictEqual(r.illegal, [], `table ${lv} deal ${SEED + 12000 + k}`);
      assert.ok(r.winner >= 0, `table ${lv} deal ${SEED + 12000 + k} ended (${r.turns} turns)`);
      r.dropped.forEach((d, i) => { if (d) { drops++; assert.strictEqual(lv[i], "sharp", "only a sharp bot drops"); assert.ok(pool, "and only in a pool game"); } });
    }
  }
  console.log(`     ${deals} deals at tables of three to six, ${drops} first-turn drops by sharp bots in the pool games`);
  assert.ok(drops > 0, "sharp does drop a hopeless hand now and then");
});

test("normal is the bot as it has always played: the same draw, the same finish, the same discard, move for move", () => {
  const draw = Bots.draw, play = Bots.play;
  let moves = 0;
  Bots.draw = (lv, t) => {
    const d = draw(lv, t);
    if (lv === "normal") { moves++; assert.strictEqual(d, eng.botWantsOpen(t.hand, t.top, t.wildRank) ? "open" : "closed", "the draw"); }
    return d;
  };
  Bots.play = (lv, t) => {
    const p = play(lv, t);
    if (lv === "normal") {
      const win = eng.botFinishCard(t.hand, t.wildRank, t.pickedOpenId);
      if (win) assert.deepStrictEqual(p, { declare: win }, "the finish");
      else assert.deepStrictEqual(p, { discard: eng.botDiscardCard(t.hand, t.wildRank, t.pickedOpenId).id }, "the discard");
    }
    return p;
  };
  try {
    for (let k = 0; k < 60; k++) { const r = Sim.playDeal(["normal", "normal", "normal"], SEED + 30000 + k, { pool: true, poolLeft: 60 }); assert.deepStrictEqual(r.illegal, []); assert.ok(!r.dropped.some(Boolean), "normal never drops"); }
  } finally { Bots.draw = draw; Bots.play = play; }
  assert.ok(moves > 500, "hundreds of moves were compared (" + moves + ")");
  assert.strictEqual(Bots.level(undefined), "normal");
  assert.strictEqual(Bots.level("hard"), "normal", "a level outside the three is normal");
  assert.deepStrictEqual(Bots.LEVELS, ["easy", "normal", "sharp"]);
});

test("easy never finishes early: it declares the turn after its hand comes together; normal and sharp declare at once", () => {
  const win13 = cards("S4 S5 S6 H7 H8 H9 C10 D10 S10 D2 D3 D4 D5"), extra = card("C13"), next = card("H1");
  const t = tableOf(win13.concat([extra]), 12);
  for (const lv of ["normal", "sharp"]) {
    const p = Bots.play(lv, tableOf(win13.concat([extra]), 12));
    assert.ok(p.declare && p.declare.id === extra.id && eng.validateDeclare(win13, p.declare.groups, 12).valid, lv + " declares");
  }
  const p1 = Bots.play("easy", t);
  assert.deepStrictEqual(p1, { discard: extra.id }, "the turn its hand is done it only throws the spare card");
  assert.strictEqual(t.mem.ready[0], true);
  t.hand = win13.concat([next]);
  assert.ok(["open", "closed"].includes(Bots.draw("easy", t)));
  const p2 = Bots.play("easy", t);
  assert.ok(p2.declare && p2.declare.id === next.id && eng.validateDeclare(win13, p2.declare.groups, 12).valid, "and declares on its next turn");
  // a hand that came apart again in between is not declared
  const t2 = tableOf(win13.concat([extra]), 12);
  Bots.play("easy", t2);
  t2.hand = cards("S4 S5 S6 H7 H8 H9 C10 D10 S1 D2 D3 D4 D5 C13");
  assert.ok(Bots.play("easy", t2).discard, "no declare without a finished hand");
  assert.strictEqual(t2.mem.ready[0], false);
});

test("easy misses takes and throws useful cards, by its own dice", () => {
  // a face-up card normal always takes: easy leaves about half of them
  const hand = cards("S4 S5 H9 D13 C2 H3 D7 C11 S9 D1 C6 H12 S13"), top = card("S6");
  assert.strictEqual(eng.botWantsOpen(hand, top, 10), true);
  const rnd = Sim.rngOf(3);
  let took = 0;
  for (let k = 0; k < 400; k++) if (Bots.draw("easy", tableOf(hand, 10, { top, open: [top], rnd })) === "open") took++;
  assert.ok(took > 140 && took < 260, "easy took it " + took + " times in 400");
  assert.strictEqual(Bots.draw("normal", tableOf(hand, 10, { top, open: [top] })), "open");
  // a pair normal keeps: easy now and then throws one of it
  const h14 = cards("S4 S5 S6 H9 D9 C2 H3 D7 C11 S1 D12 C6 H13 S13");
  const usual = eng.botDiscardCard(h14, 10, null).id;
  let slips = 0;
  for (let k = 0; k < 400; k++) if (Bots.play("easy", tableOf(h14, 10, { rnd })).discard !== usual) slips++;
  assert.ok(slips > 40 && slips < 200, "easy threw another card " + slips + " times in 400");
});

test("an easy bot does not sit for ever on a hand that is all melds and cannot be declared", () => {
  /* Four sets and no sequence. The seven of diamonds would make the pure sequence 5-6-7, at the price of two sets:
     normal's rule throws it back every time. Easy does the same while it is new to the spot, and keeps it once it has
     been stuck for EASY.stuck turns. */
  const sets = cards("C3 D3 H3 S3 C10 D10 H10 S5 D5 H5 S6 D6 H6");
  assert.strictEqual(eng.deadwood(sets, 9), 0);
  assert.strictEqual(eng.bestArrangement(sets, 9, 30000), null, "nothing to declare");
  const t = tableOf(sets.slice(), 9);
  const junk = ["C12", "S12", "H13", "S1", "C1", "D13", "H1", "S13", "C13", "D12", "H12", "D1"];
  for (let turn = 0; turn < Bots.EASY.stuck - 1; turn++) {
    const drawn = card(turn === 1 ? "D7" : junk[turn % junk.length]);
    assert.strictEqual(eng.botDiscardCard(sets.concat([drawn]), 9, null).id, drawn.id, "normal throws back whatever it draws");
    t.hand = sets.concat([drawn]);
    assert.deepStrictEqual(Bots.play("easy", t), { discard: drawn.id }, "and so does easy, on turn " + (turn + 1));
    assert.strictEqual(t.mem.stuck[0], turn + 1);
  }
  const d7 = card("D7");
  const ps = Bots.play("sharp", tableOf(sets.concat([d7]), 9));
  assert.ok(ps.discard && ps.discard !== d7.id, "sharp never sat there: it keeps the card at once");
  t.hand = sets.concat([d7]);
  const p = Bots.play("easy", t);
  assert.ok(p.discard && p.discard !== d7.id, "stuck long enough, it keeps the card that starts a sequence");
  const kept = t.hand.filter((c) => c.id !== p.discard).map(text);
  assert.ok(["D5", "D6", "D7"].every((x) => kept.includes(x)), "and holds the three in a row");
  // the deal that showed it: before, this one ran to the turn cap
  const r = Sim.playDeal(["normal", "easy"], 31915);
  assert.ok(r.winner >= 0 && r.turns < 200, "deal 31915 ends (" + r.turns + " turns)");
});

test("sharp drops only a hopeless first hand, only in a pool game with three still in, never when 20 points would put it out; easy and normal never drop", () => {
  const hopeless = cards("S1 S4 S7 S10 H2 H5 H8 H11 D3 D6 D9 D12 C1"), top = card("H13");
  const at = (lv, more) => Bots.draw(lv, tableOf(hopeless, 13, Object.assign({ seats: 4, top, open: [top], firstTurn: true, pool: true, poolLeft: 101, active: 4 }, more)));
  assert.strictEqual(at("sharp", {}), "drop");
  assert.strictEqual(at("sharp", { poolLeft: 21 }), "drop");
  assert.strictEqual(at("sharp", { poolLeft: 20 }), "closed", "20 points would put it out");
  assert.strictEqual(at("sharp", { pool: false }), "closed", "points are not carried on outside a pool game");
  assert.strictEqual(at("sharp", { firstTurn: false }), "closed", "a later drop costs 40");
  assert.strictEqual(at("sharp", { active: 2 }), "closed", "never from a table of two");
  assert.strictEqual(at("sharp", { active: 3 }), "drop");
  assert.strictEqual(at("easy", {}), "closed");
  assert.strictEqual(at("normal", {}), "closed");
  const good = cards("S4 S5 S6 H7 H8 H9 C10 D10 S10 D2 D3 C4 C9");
  assert.notStrictEqual(Bots.draw("sharp", tableOf(good, 13, { seats: 4, top, open: [top], firstTurn: true, pool: true, poolLeft: 101, active: 4 })), "drop", "a hand worth playing is played");
});

test("sharp does not feed the next player and remembers what was thrown", () => {
  // two loose cards of the same worth: the next player took the 8 of hearts, so the 9 of hearts is the one not to throw
  const hand = cards("S2 S3 S4 D5 D6 D7 C11 C12 C13 H1 D1 H9 S9 C5");
  const took = card("H8");
  const t = tableOf(hand, 10, { seats: 2 });
  Bots.noteDraw(t.mem, 1, "open", took, null);
  const p = Bots.play("sharp", t);
  assert.ok(p.discard, "no finish here");
  assert.notStrictEqual(text(hand.find((c) => c.id === p.discard)), "H9", "not the card that goes with what they took");
  // the memory itself: a card taken is held until it is thrown again; a card left lying is remembered as passed
  const mem = Bots.memory(2), c1 = card("H5"), c2 = card("D9");
  Bots.noteDraw(mem, 0, "open", c1, null);
  assert.deepStrictEqual(mem.took[0].map(text), ["H5"]);
  Bots.noteDiscard(mem, 0, c1);
  assert.deepStrictEqual(mem.took[0], []);
  assert.deepStrictEqual(mem.threw[0].map(text), ["H5"]);
  Bots.noteDraw(mem, 1, "closed", null, c2);
  assert.deepStrictEqual(mem.passed[1].map(text), ["D9"]);
  Bots.noteDraw(null, 0, "open", c1, null); Bots.noteDiscard(null, 0, c1);   // a table with no memory: nothing happens
});

test("a sharp bot that loses pays for its loose cards only; easy and normal pay as they always have", () => {
  const hand = cards("H2 H3 H4 S5 S6 S7 C9 D9 S9 C13 D1 H7 S11");
  const g = Bots.groups("sharp", hand, 12);
  assert.ok(Array.isArray(g) && g.length >= 3, "its hand is grouped");
  assert.strictEqual(eng.scoreHand(hand, g, 12), 37, "the king, the ace, the seven and the jack");
  assert.strictEqual(eng.scoreHand(hand, [], 12), 80, "ungrouped, the whole hand (capped)");
  assert.strictEqual(Bots.groups("normal", hand, 12), null);
  assert.strictEqual(Bots.groups("easy", hand, 12), null);
  // without a pure sequence and a second sequence grouping saves nothing, and none is claimed
  assert.strictEqual(Bots.groups("sharp", cards("C3 D3 H3 S3 C10 D10 H10 S5 D5 H5 S6 D6 H1"), 9), null);
  // every id is the hand's own, none twice
  const ids = g.flat();
  assert.strictEqual(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => hand.some((c) => c.id === id)));
});

test("the finish search does not hang on a hand full of jokers, and answers as it always did", () => {
  // eight jokers and no three cards in a row: before, each turn of this hand cost seconds
  const h14 = cards("C8 J0 H3 S3 C3 D8 J0 D2 D8 H2 H8 H6 S8 H8");
  let t0 = Date.now();
  assert.strictEqual(eng.botFinishCard(h14, 8, null), null);
  const ms = Date.now() - t0;
  assert.ok(ms < 500, "no finish, found out in " + ms + " ms");
  const h14b = cards("C8 J0 H3 H4 H5 D8 J0 D2 D8 S2 H8 C6 S8 H8");
  t0 = Date.now();
  const win = eng.botFinishCard(h14b, 8, null);
  assert.ok(win && eng.validateDeclare(h14b.filter((c) => c.id !== win.id), win.groups, 8).valid, "a finish among eight jokers");
  assert.ok(Date.now() - t0 < 500);
  // the same arrangements as the search gave before it was cut down (taken from the server as it was)
  const SAME = [
    ["S4 S5 S6 H7 H8 H9 C10 D10 S10 D2 D3 D4 D5", 12, ["C10 D10 S10", "D2 D3 D4 D5", "H7 H8 H9", "S4 S5 S6"]],
    ["S4 S5 S6 H7 H8 J0 C10 D10 S10 D2 D3 D4 D12", 12, ["C10 D10 S10", "D2 D3 D4", "H7 H8 J0", "S4 S5 S6 D12"]],
    ["H6 H7 H8 S2 S3 C8 D11 D12 D13 C5 D5 S8 J0", 8, ["C5 D5 H8", "D11 D12 D13", "H6 H7 C8", "S2 S3 S8 J0"]],
    ["C8 J0 H3 H4 H5 D8 J0 D2 D8 S2 H8 S8 H8", 8, ["D2 C8 J0", "H3 H4 H5", "S2 D8 J0", "D8 H8 S8 H8"]],
    ["C8 J0 H3 S3 C3 D8 J0 D2 D8 H2 H8 S8 H8", 8, null],
    ["C3 D3 H3 S3 C10 D10 H10 S5 D5 H5 S6 D6 H6", 9, null],
    ["S1 S12 S13 H1 H2 H3 D7 D7 C7 C9 C10 C11 J0", 4, null],
  ];
  for (const [h, wr, want] of SAME) {
    const hand = cards(h), by = new Map(hand.map((c) => [c.id, c]));
    const a = eng.bestArrangement(hand, wr, 30000);
    assert.deepStrictEqual(a ? a.groups.map((g) => g.map((id) => text(by.get(id))).join(" ")) : null, want, h);
  }
});

/* ------------------------------------------------------------------ part 2: over the wire */

const net = require("net");
const free = (port) => new Promise((res) => { const s = net.createServer(); s.once("error", () => res(false)); s.once("listening", () => s.close(() => res(true))); s.listen(port, "127.0.0.1"); });
const until = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await pause(15); } return false; };
const socks = [];
function client(port) {
  const s = io(`http://127.0.0.1:${port}`, { transports: ["websocket"], forceNew: true, reconnection: false });
  s.st = null; s.seat = -1; s.code = null; s.refusals = []; s.states = 0;
  s.on("state", ({ room, mySeat }) => { s.st = room; s.seat = mySeat; s.states++; });
  s.on("joined", (j) => { s.code = j.code; });
  s.on("refusal", (r) => s.refusals.push(r));
  socks.push(s);
  return s;
}
let pid = 0;
const id = (tag) => `bl_${tag}_${process.pid}_${++pid}`;
/* A room: the host and, when asked, a second person. */
async function roomOf(port, guest) {
  const a = client(port);
  a.emit("create", { name: "Ava", playerId: id("a") });
  assert.ok(await until(() => a.code && a.st), "the room was made");
  let b = null;
  if (guest) { b = client(port); b.emit("join", { code: a.code, name: "Ben", playerId: id("b") }); assert.ok(await until(() => b.st && a.st.players.length === 2), "the guest sat down"); }
  return { a, b };
}
const WIN13 = "S4 S5 S6 H7 H8 H9 D2 D3 D4 D5 C10 C11 C12";            // four pure sequences: a declare whatever the wild rank
const JUNK13 = "S2 S9 S13 H1 H4 H11 D7 D10 D12 C3 C6 C8 H13";
const HALF13 = "H2 H3 H4 S5 S6 S7 C9 D9 S9 C13 D1 H7 S11";            // two pure sequences, a set and four loose cards
const plain = (s) => s.split(" ").map((t) => ({ s: t[0], r: Number(t.slice(1)) }));
const holds = (st, s) => st.yourHand.length === 13 && plain(s).every((w) => st.yourHand.some((c) => c.s === w.s && c.r === w.r));
/* The host's turn, before the draw: hands are laid by the test hook, then the host draws and declares. */
async function myTurn(c) { assert.ok(await until(() => c.st.status === "playing" && c.st.turn === c.seat && c.st.phase === "draw", 8000), "the host's turn came"); }
async function drawAndDeclare(c) {
  const ids13 = new Set(c.st.yourHand.map((x) => x.id));
  c.emit("draw", { from: "closed" });
  assert.ok(await until(() => c.st.phase === "discard" && c.st.yourHand.length === 14), "drew");
  const drawn = c.st.yourHand.find((x) => !ids13.has(x.id)), kept = c.st.yourHand.filter((x) => x.id !== drawn.id);
  const win = eng.bestArrangement(kept, c.st.wildRank, 30000);
  assert.ok(win, "the crafted hand is a declare");
  c.emit("declare", { discardId: drawn.id, groups: win.groups });
  assert.ok(await until(() => c.st.status === "over"), "the declare ended the deal");
}
async function drawAndThrow(c) {
  const ids13 = new Set(c.st.yourHand.map((x) => x.id));
  c.emit("draw", { from: "closed" });
  assert.ok(await until(() => c.st.phase === "discard" && c.st.yourHand.length === 14), "drew");
  c.emit("discard", { id: c.st.yourHand.find((x) => !ids13.has(x.id)).id });
}

const A = PORT, B = PORT2;   // A: a patient table (a person's turn lasts a minute); B: a turn times out in 150 ms
{
  test("a room at normal sends exactly what it always sent; the level is the host's pick, in the lobby", async () => {
    const { a, b } = await roomOf(A, true);
    assert.ok(a.st.features.includes("botLevels"), "the server says it takes the setting");
    assert.ok(!("botLevel" in a.st) && !("botLevel" in b.st), "no level in a room that never picked one");
    b.emit("settings", { botLevel: "sharp" });
    await pause(200);
    assert.ok(!("botLevel" in a.st), "a guest's pick changes nothing");
    a.emit("settings", { botLevel: "sharp" });
    assert.ok(await until(() => a.st.botLevel === "sharp" && b.st.botLevel === "sharp"), "the host's pick reaches everyone");
    assert.strictEqual(Object.keys(a.st).pop(), "botLevel", "after every other field");
    assert.strictEqual(a.st.log, "The bots will play sharp.");
    for (const bad of ["hard", "SHARP", 2, null, ["easy"]]) {
      const n = a.refusals.length;
      a.emit("settings", { botLevel: bad });
      assert.ok(await until(() => a.refusals.length === n + 1), "refused: " + JSON.stringify(bad));
      assert.deepStrictEqual(a.refusals[n], { code: "bot_level", message: "No such bot level.", op: "settings" });
      assert.strictEqual(a.st.botLevel, "sharp");
    }
    a.emit("settings", { botLevel: "normal" });
    assert.ok(await until(() => !("botLevel" in a.st) && !("botLevel" in b.st)), "back at normal the field is gone again");
    assert.strictEqual(a.st.log, "The bots will play their usual game.");
    a.emit("settings", { pool: 101, botLevel: "easy" });
    assert.ok(await until(() => a.st.pool === 101 && a.st.botLevel === "easy"), "the pool and the level in one message");
    assert.ok(/^Pool game to 101/.test(a.st.log), "one line of log: the pool's, when both change at once");
    a.emit("settings", { pool: 0 });
    assert.ok(await until(() => a.st.pool === 0));
    assert.strictEqual(a.st.botLevel, "easy", "a settings message without the level leaves it");
    a.emit("start");
    assert.ok(await until(() => a.st.status === "playing"));
    assert.strictEqual(Object.keys(a.st).pop(), "botLevel");
    a.emit("settings", { botLevel: "sharp" });
    await pause(200);
    assert.strictEqual(a.st.botLevel, "easy", "not once the game has started");
    a.close(); b.close();
    // a room that never touches the setting, started: still no such field
    const r = await roomOf(A, true);
    r.a.emit("start");
    assert.ok(await until(() => r.a.st.status === "playing"));
    assert.ok(!("botLevel" in r.a.st) && !("botLevel" in r.b.st));
    r.a.close(); r.b.close();
  });

  test("quick play keeps the normal bots", async () => {
    const q = client(A);
    q.emit("quick", { name: "Quin", playerId: id("q") });
    assert.ok(await until(() => q.st && q.st.quick), "a quick-play room");
    q.emit("settings", { botLevel: "sharp" });
    assert.ok(await until(() => q.refusals.length === 1));
    assert.deepStrictEqual(q.refusals[0], { code: "bot_level", message: "Quick play uses the normal bots.", op: "settings" });
    q.emit("settings", { botLevel: "normal" });
    await pause(150);
    assert.strictEqual(q.refusals.length, 1, "normal is what it has");
    assert.ok(await until(() => q.st.status === "playing", 8000), "the seats filled and the game began");
    assert.ok(q.st.players.some((p) => p.bot));
    assert.ok(!("botLevel" in q.st), "no level in its state");
    assert.strictEqual(q.st.rankedOn, true, "and its game counts");
    q.close();
  });

  test("a game with easy or sharp bots is not rated; people only, and the normal bots, count as ever", async () => {
    const { a } = await roomOf(A, false);
    a.emit("addBot");
    assert.ok(await until(() => a.st.players.length === 2));
    assert.strictEqual(a.st.rankedOn, true, "a normal bot: rated, as today");
    for (const lv of ["sharp", "easy"]) {
      a.emit("settings", { botLevel: lv });
      assert.ok(await until(() => a.st.botLevel === lv));
      assert.strictEqual(a.st.rankedOn, false, lv + " bots: not rated");
    }
    a.emit("removeBot");
    assert.ok(await until(() => a.st.players.length === 1));
    const b = client(A);
    b.emit("join", { code: a.code, name: "Ben", playerId: id("b") });
    assert.ok(await until(() => b.st && a.st.players.length === 2));
    assert.strictEqual(a.st.botLevel, "easy");
    assert.strictEqual(a.st.rankedOn, true, "two people and no bot: rated whatever the level says");
    a.close(); b.close();

    // played out: against a sharp bot nothing is rated, against a normal bot the result is
    for (const [lv, rated] of [["sharp", false], ["normal", true]]) {
      const r = await roomOf(A, false);
      r.a.emit("addBot");
      if (lv !== "normal") r.a.emit("settings", { botLevel: lv });
      assert.ok(await until(() => r.a.st.players.length === 2 && (lv === "normal" || r.a.st.botLevel === lv)));
      r.a.emit("start");
      await myTurn(r.a);
      r.a.emit("__test", { hands: { [r.a.seat]: plain(WIN13), [1 - r.a.seat]: plain(JUNK13) } });
      assert.ok(await until(() => holds(r.a.st, WIN13)));
      await drawAndDeclare(r.a);
      assert.strictEqual(r.a.st.winner, r.a.seat);
      await pause(900);   // the ratings look at finished rooms twice a second
      assert.strictEqual(r.a.st.rankedOn, rated);
      assert.strictEqual(!!r.a.st.rated, rated, lv + ": " + (rated ? "rated" : "not rated"));
      r.a.close();
    }
  });

  test("a sharp bot loses with its hand grouped; an easy one pays for every card, as bots always have", async () => {
    for (const lv of ["sharp", "easy"]) {
      const { a } = await roomOf(A, false);
      a.emit("addBot"); a.emit("settings", { botLevel: lv });
      assert.ok(await until(() => a.st.players.length === 2 && a.st.botLevel === lv));
      a.emit("start");
      await myTurn(a);
      a.emit("__test", { hands: { [a.seat]: plain(WIN13), [1 - a.seat]: plain(HALF13) } });
      assert.ok(await until(() => holds(a.st, WIN13)));
      await drawAndDeclare(a);
      const wr = a.st.wildRank, mine = cards(HALF13);
      const grouped = eng.scoreHand(mine, Bots.groups("sharp", mine, wr) || [], wr), whole = eng.scoreHand(mine, [], wr);
      assert.ok(grouped < whole, "grouping saves points here (wild rank " + wr + ")");
      const row = a.st.results.find((x) => x.seat === 1 - a.seat);
      assert.strictEqual(row.points, lv === "sharp" ? grouped : whole, lv + " (wild rank " + wr + ")");
      a.close();
    }
  });

  test("an easy bot declares a turn late over the wire too", async () => {
    const { a } = await roomOf(A, false);
    a.emit("addBot"); a.emit("settings", { botLevel: "easy" });
    assert.ok(await until(() => a.st.players.length === 2 && a.st.botLevel === "easy"));
    a.emit("start");
    await myTurn(a);
    const bot = 1 - a.seat;
    a.emit("__test", { hands: { [a.seat]: plain(JUNK13), [bot]: plain(WIN13) } });
    assert.ok(await until(() => holds(a.st, JUNK13)));
    await drawAndThrow(a);
    assert.ok(await until(() => a.st.status === "over" || (a.st.turn === a.seat && a.st.phase === "draw")), "the bot played");
    assert.strictEqual(a.st.status, "playing", "its hand was done and it only threw a card");
    assert.strictEqual(a.st.lastMove.kind, "discard");
    await drawAndThrow(a);
    assert.ok(await until(() => a.st.status === "over"), "on its next turn it declares");
    assert.strictEqual(a.st.winner, bot);
    a.close();
  });

  test("a seat a person left to the clock plays the normal game, whatever the room's level", async () => {
    const { a } = await roomOf(B, false);
    a.emit("addBot"); a.emit("settings", { botLevel: "easy" });
    assert.ok(await until(() => a.st.players.length === 2 && a.st.botLevel === "easy"));
    a.emit("start");
    assert.ok(await until(() => a.st.status === "playing"));
    /* The host never moves. With a finished hand in a person's seat the clock's bot declares on that very turn (an
       easy bot's seat would throw a card first, as the test above shows). */
    let laid = false;
    for (let k = 0; k < 40 && !laid; k++) {
      await until(() => a.st.status !== "playing" || (a.st.turn === a.seat && a.st.phase === "draw"), 4000);
      assert.strictEqual(a.st.status, "playing", "nobody finished before the hands were laid");
      const v = a.states;
      a.emit("__test", { hands: { [a.seat]: plain(WIN13), [1 - a.seat]: plain(JUNK13) } });
      await until(() => a.states > v);
      laid = a.st.status === "playing" && a.st.turn === a.seat && a.st.phase === "draw" && holds(a.st, WIN13);   // not if the clock ran out in between
    }
    assert.ok(laid, "the hands were laid on the host's turn");
    assert.ok(await until(() => a.st.status === "over" || a.st.turn !== a.seat, 3000), "the clock ran out");
    assert.strictEqual(a.st.status, "over", "declared at once");
    assert.strictEqual(a.st.winner, a.seat);
    a.close();
  });

  test("in a pool game a sharp bot drops a hopeless first hand for 20 points; an easy one plays it", async () => {
    const HOPELESS = "S1 S4 S7 S10 H2 H5 H8 H11 D3 D6 D9 D12 C13 S13 C1 C7 C4 C10";   // far apart in every suit; the wild rank's cards are left out
    for (const lv of ["sharp", "easy"]) {
      let a = null;
      for (let k = 0; k < 40 && !a; k++) {   // a deal the host opens: no bot has had its first turn yet
        const r = await roomOf(A, false);
        r.a.emit("addBot"); r.a.emit("addBot"); r.a.emit("settings", { pool: 101, botLevel: lv });
        assert.ok(await until(() => r.a.st.players.length === 3 && r.a.st.botLevel === lv && r.a.st.pool === 101));
        r.a.emit("start");
        assert.ok(await until(() => r.a.st.status === "playing"));
        if (r.a.st.turn === r.a.seat && r.a.st.lastMove == null) a = r.a; else r.a.close();
      }
      assert.ok(a, "a deal the host opens");
      const wr = a.st.wildRank, bot = (a.seat + 1) % 3, other = (a.seat + 2) % 3;
      const bad = plain(HOPELESS).filter((c) => c.r !== wr).slice(0, 13);
      a.emit("__test", { hands: { [a.seat]: plain(WIN13), [bot]: bad, [other]: plain(JUNK13) } });
      assert.ok(await until(() => holds(a.st, WIN13)));
      let dropSeen = false;
      a.on("state", ({ room }) => { if (room.lastMove && room.lastMove.kind === "drop" && room.lastMove.seat === bot) dropSeen = true; });
      await drawAndThrow(a);
      assert.ok(await until(() => a.st.turn === a.seat && a.st.phase === "draw"), "both bots have played");
      assert.strictEqual(a.st.status, "playing");
      assert.strictEqual(a.st.players[bot].out, lv === "sharp", lv + (lv === "sharp" ? " dropped" : " played on") + " (wild rank " + wr + ")");
      assert.strictEqual(dropSeen, lv === "sharp");
      assert.strictEqual(a.st.players[other].out, false, "the third seat plays on: with two left nobody walks away");
      await drawAndDeclare(a);
      const row = a.st.results.find((x) => x.seat === bot);
      if (lv === "sharp") { assert.strictEqual(row.dropped, true); assert.strictEqual(row.points, 20); assert.strictEqual(a.st.totals[bot], 20); }
      else assert.ok(!row.dropped && row.points > 20);
      a.close();
    }
  });

  test("whole games at each level play themselves out: no bot turn fails, none has to be rescued", async () => {
    for (const lv of ["easy", "sharp", "normal"]) {
      const { a } = await roomOf(B, false);
      a.emit("addBot"); a.emit("addBot"); a.emit("addBot");
      if (lv !== "normal") a.emit("settings", { botLevel: lv });
      assert.ok(await until(() => a.st.players.length === 4 && (lv === "normal" || a.st.botLevel === lv)));
      a.emit("start");
      assert.ok(await until(() => a.st.status === "over", 60000), lv + ": the deal ended by itself");
      assert.ok(a.st.winner >= 0 && a.st.results.length === 4);
      a.close();
    }
    // a pool game of four at sharp, deal after deal until somebody has won the pool: the level stays across the deals
    const { a } = await roomOf(B, false);
    a.emit("addBot"); a.emit("addBot"); a.emit("addBot"); a.emit("settings", { pool: 101, botLevel: "sharp" });
    assert.ok(await until(() => a.st.players.length === 4 && a.st.botLevel === "sharp" && a.st.pool === 101));
    a.emit("start");
    let deals = 0, drops = 0;
    for (;;) {
      assert.ok(await until(() => a.st.status === "over", 60000), "deal " + (deals + 1) + " ended by itself");
      deals++;
      drops += a.st.results.filter((x) => x.dropped).length;
      assert.strictEqual(a.st.botLevel, "sharp");
      if (a.st.champion != null) break;
      assert.ok(deals < 40, "a pool of 101 is settled long before 40 deals");
      a.emit("rematch");
      assert.ok(await until(() => a.st.status === "playing"), "the next deal began");
    }
    console.log(`     a pool of 101 at sharp: ${deals} deals, ${drops} drops`);
    for (const port of [A, B]) {
      const c = client(port);
      let stats = null;
      c.on("botStats", (s) => { stats = s; });
      c.emit("create", { name: "Stat", playerId: id("s") });
      assert.ok(await until(() => c.code));
      c.emit("__botStats");
      assert.ok(await until(() => stats));
      assert.ok(stats.actions > (port === B ? 100 : 5), "the bots played (" + stats.actions + " turns)");
      assert.strictEqual(stats.failed, 0, "no bot turn threw");
      assert.strictEqual(stats.watchdog, 0, "no bot had to be woken");
      c.close();
    }
  });
}

/* ------------------------------------------------------------------ run */

(async () => {
  for (const p of [PORT, PORT2]) if (!(await free(p))) { console.error("port " + p + " is busy; set TEST_PORT / TEST_PORT2"); process.exit(2); }
  /* Everything these servers write goes to a folder of its own under the system's temp folder, removed at the end,
     unless the caller already said where (RANK_DIR). */
  const scratch = process.env.RANK_DIR ? null : fs.mkdtempSync(path.join(os.tmpdir(), "rummy-botlevels-"));
  const env = { ...process.env, BOT_MS: "5", TEST_HOOKS: "1", QUICK_FILL_MS: "300" };
  if (scratch) env.RANK_DIR = path.join(scratch, "ratings");
  const ROOT = path.join(__dirname, "..");
  const servers = [
    spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...env, PORT: String(PORT) }, stdio: "ignore" }),
    spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...env, PORT: String(PORT2), TURN_MS: "150" }, stdio: "ignore" }),
  ];
  const stop = () => {
    for (const s of socks) try { s.close(); } catch (_) {}
    for (const s of servers) try { s.kill(); } catch (_) {}
    if (scratch) try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) {}
  };
  try {
    await pause(800);
    await runAll();
  } catch (e) { failed++; console.log("  FAILED " + ((e && e.stack) || e)); }
  stop();
  console.log(`\nbot levels: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
