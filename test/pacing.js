/* Rummy bot pacing (pacing round 1, 2026-11-01): a bot's turn takes 0.7-1.9 s (the median about a second), the three bots of a
   four-seat table keep a person waiting about three seconds, and a bot whose timer was lost still plays (the watchdog).
   Own server on TEST_PORT2 (default 5441... see below), real clocks (BOT_MS unset), TEST_HOOKS=1. Never 3111-3124.
     TEST_PORT2=5444 node test/pacing.js */
"use strict";
const { spawn } = require("child_process");
const path = require("path");
const { io } = require("socket.io-client");
const eng = require("../server.js");
const PORT = Number(process.env.TEST_PORT2 || 3421);
if (PORT >= 3111 && PORT <= 3124) { console.error("refusing " + PORT + ": the live servers"); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (cond, name, extra) => { if (!cond) { console.error("  FAIL " + name, extra === undefined ? "" : JSON.stringify(extra)); process.exitCode = 1; } else { passed++; console.log("  ok " + name); } };
const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: { ...process.env, PORT: String(PORT), TEST_HOOKS: "1", BOT_STALL_MS: "400", BOT_MS: "", TURN_MS: "60000" }, stdio: "ignore" });
  await sleep(800);
  try {
    let stats = null;
    const tables = [];
    const until = async (pred, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(25); } return false; };
    /* A table of four: a person and three bots. The person draws from the closed pile and throws its dearest card; with `declares` it
       also goes out when it can. A parked table's person stops playing, so no bot thinks there (its 60 s turn clock is far off). */
    const deal = async (name, playerId, declares) => {
      const s = io(`http://127.0.0.1:${PORT}`, { transports: ["websocket"], forceNew: true });
      const T = { s, log: [], me: -1, parked: false, lastKey: "" };
      tables.push(T);
      s.on("botStats", (b) => { stats = b; });
      s.on("state", ({ room, mySeat }) => {
        T.me = mySeat;
        T.log.push({ t: Date.now(), turn: room.turn, phase: room.phase, status: room.status });
        const key = room.turn + "|" + room.phase + "|" + (room.yourHand ? room.yourHand.length : 0) + "|" + room.log;
        if (T.parked || room.status !== "playing" || room.turn !== T.me || key === T.lastKey) return;
        T.lastKey = key;
        if (room.phase === "draw") { s.emit("draw", { from: "closed" }); return; }
        const hand = room.yourHand;
        if (declares) for (const cand of hand) {
          if (cand.id === room.pickedOpenId) continue;
          const win = eng.bestArrangement(hand.filter((c) => c.id !== cand.id), room.wildRank, 3000);
          if (win) { s.emit("declare", { discardId: cand.id, groups: win.groups }); return; }
        }
        const dear = hand.filter((c) => c.id !== room.pickedOpenId).map((c) => ({ c, p: eng.cardPoints(c, room.wildRank) })).sort((a, b) => b.p - a.p)[0];
        s.emit("discard", { id: dear.c.id });
      });
      s.emit("create", { name, playerId });
      await new Promise((r) => s.once("joined", () => r()));
      for (let i = 0; i < 3; i++) { s.emit("addBot"); await sleep(60); }
      s.emit("start");
      return T;
    };
    const last = (T) => T.log[T.log.length - 1];
    const park = async (T) => { T.parked = true; await until(() => { const l = last(T); return l && (l.status !== "playing" || l.turn === T.me); }, 12000); };

    console.log("rummy pacing: four seats, real clocks");
    /* A round of rummy can be over in a few turns (a bot, or the person here, goes out early), before there is enough to measure. The
       check used to fail then ("saw the bots' turns 4") on a server that had paced every one of those turns rightly (2026-11-13: 2 runs
       in 20). So when a table ends short, another is dealt and its turns are added, until there are the six bot turns and the two waits
       the bars below have always been held on. Each finished table is parked on the person's turn. */
    const waits = [], down = [];
    let dealt = 0;
    while ((waits.length < 6 || down.length < 2) && dealt < 6) {
      const T = await deal("Ava", "p_pace_rummy" + (dealt ? "_" + dealt : ""), true); dealt++;
      await until(() => T.log.length > 4 && T.log.some((l) => l.status === "playing"), 4000);
      // a few rounds of the table
      await until(() => T.log.filter((l) => l.turn === T.me && l.phase === "draw").length >= 4 || (T.log.length && last(T).status === "over"), 40000);
      await park(T);
      let away = null;
      for (let i = 0; i + 1 < T.log.length; i++) {
        const a = T.log[i], b = T.log[i + 1];
        if (a.status !== "playing") continue;
        if (a.turn !== T.me && b.turn !== a.turn) waits.push(b.t - a.t);
        if (a.turn !== T.me && away === null) away = a.t;
        if (b.turn === T.me && b.phase === "draw" && away !== null) { down.push(b.t - away); away = null; }
      }
    }
    ok(waits.length >= 6, "saw the bots' turns", waits.length);
    ok(Math.min(...waits) >= 600 && Math.max(...waits) <= 2300, "every bot turn takes 0.6-2.3 s", [Math.min(...waits), Math.max(...waits)]);
    ok(med(waits) >= 750 && med(waits) <= 1400, "and the median is about a second", med(waits));
    ok(down.length >= 2 && med(down) <= 4200, "three bots keep a person waiting no more than about four seconds", down);
    console.log(`  (bot turns ${waits.length} at ${dealt} table${dealt > 1 ? "s" : ""}: p50 ${med(waits)} ms, max ${Math.max(...waits)} ms; waits between my turns ${down.join(" ")} ms)`);

    console.log("rummy pacing: the watchdog");
    /* A table of its own (2026-11-13). This used to lose the timer of the next bot at the pacing table above, and that table can be
       over by now (a bot that goes out in its third turn ends the round): no bot is thinking, there is no timer to lose, and the two
       checks failed ("lost": false, "watchdog": 0) on a server that was right. So the pacing tables are parked (no bot thinks there),
       a new table is dealt whose person only draws and throws, and the timer is lost on a bot's turn there. If the hook lands as that
       bot plays (lost: false), the next bot's turn is taken. */
    const W = await deal("Wren", "p_pace_rummy_w", false);
    let turnWas = -1, t0 = 0;
    for (let tries = 0; tries < 4; tries++) {
      // wait for a bot's turn, then lose its timer
      await until(() => { const l = last(W); return l && l.status === "playing" && l.turn !== W.me && l.turn !== turnWas; }, 8000);
      stats = null; turnWas = last(W) ? last(W).turn : -1;
      W.s.emit("__loseBotTimer"); t0 = Date.now();
      await until(() => stats !== null, 2000);
      if (stats && stats.lost) break;
    }
    ok(stats && stats.lost === true, "the bot's timer was lost", stats);
    const before = stats ? stats.watchdog : 0;
    ok(await until(() => last(W).turn !== turnWas || last(W).status !== "playing", 4500), "the bot still played");
    const took = Date.now() - t0;
    W.s.emit("__botStats"); await until(() => stats.watchdog > before, 1000);
    ok(stats.watchdog === before + 1, "by the watchdog", stats);
    ok(took <= 3000, `within its time and BOT_STALL_MS (${took} ms)`, took);
    for (const T of tables) T.s.close();
    console.log(`${passed} passed`);
  } finally { srv.kill(); }
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
