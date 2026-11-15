/* Rummy: the host picks the table's look in the lobby of a Plus room (the owner, 2026-11-06: "I like all 3 for rummy": the tea-estate pavilion free, the Diwali rooftop and the desert camp Plus), over real
   sockets: node test/plus_look.js. Starts its own server on TEST_PORT (default 5575; never 3111-3125).
   The table is the HOST's look: every app is told it in the state; a guest's pick, an id outside the list, a slot that is not a table's, a pick once the game has started, a pick in a room without Plus
   and a pick from a bot's seat all change nothing; a Plus room begins at the tea pavilion (the free table), and so does any room. */
"use strict";
const assert = require("assert");
const { spawn } = require("child_process");
const path = require("path");
const { io } = require("socket.io-client");
const Plus = require("../plus");

const PORT = Number(process.env.TEST_PORT || 5575);
if (PORT >= 3111 && PORT <= 3125) { console.error("refusing " + PORT + ": 3111-3125 are the live servers"); process.exit(2); }
const URL = `http://127.0.0.1:${PORT}`;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (name) => { passed++; console.log("  ok " + name); };

// plus.js on its own: the lists and who may pick.
(function unit() {
  assert.deepStrictEqual(Plus.LOOKS.rummy, ["tea", "diwali", "desert"], "the three rooms, the free one first");
  assert.strictEqual(Plus.DEFAULT_LOOK.rummy, "tea", "the tea pavilion is every room's table");
  assert.strictEqual(Plus.cleanLook({ rummy: "rooftop" }).rummy, "tea", "an id outside the list is the tea pavilion");
  assert.strictEqual(Plus.cleanLook({ rummy: "desert" }).rummy, "desert");
  const host = Plus.stamp({ id: "h" }, { plus: true });
  const guest = Plus.stamp({ id: "g" }, { plus: false });
  const bot = { id: "b", bot: true };
  const room = { status: "lobby", host: "h", players: [host, guest, bot] };
  assert.strictEqual(Plus.pickLook(room, "g", "rummy", "diwali"), false, "a guest cannot");
  assert.strictEqual(Plus.pickLook(room, "h", "rummy", "diwali"), true, "the host can");
  assert.strictEqual(host.look.rummy, "diwali");
  assert.strictEqual(Plus.pickLook(room, "h", "rummy", "diwali"), false, "the same pick again changes nothing");
  assert.strictEqual(Plus.pickLook(room, "h", "rummy", "garden"), false, "an id outside the list");
  assert.strictEqual(Plus.pickLook(room, "h", "ball", "gold"), false, "a ball is not a table's slot");
  assert.strictEqual(Plus.pickLook(room, "h", "snakes", "pharaoh"), false, "nor is another game's table here");
  assert.strictEqual(Plus.pickLook(room, "h", "__proto__", "x"), false, "nothing outside the slots");
  room.status = "playing";
  assert.strictEqual(Plus.pickLook(room, "h", "rummy", "desert"), false, "not once the game has started");
  room.status = "lobby";
  guest.plus = false; host.plus = false;
  assert.strictEqual(Plus.pickLook(room, "h", "rummy", "desert"), false, "no Plus, no second table");
  assert.strictEqual(Plus.pickLook(null, "h", "rummy", "desert"), false);
  ok("plus.js: who may pick and what");
})();

async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: { ...process.env, PORT, BOT_MS: "5" }, stdio: "ignore" });
  const socks = [];
  const client = () => { const s = io(URL, { transports: ["websocket"], forceNew: true }); socks.push(s); return s; };
  await pause(700);
  try {
    const last = new Map();   // the newest state each socket has been sent
    const watch = (s) => s.on("state", (st) => last.set(s, st));
    const tableOf = (s) => { const st = last.get(s); const h = st && st.room.players[st.room.hostSeat]; return h && h.look ? h.look.rummy : undefined; };

    // A Plus room: the host owns Plus, the guest does not.
    const a = client(), c = client();
    watch(a); watch(c);
    a.emit("create", { name: "Ava", playerId: "p_ava" + Date.now(), plus: true });
    await pause(300);
    const code = last.get(a).room.code;
    c.emit("join", { code, name: "Cal", playerId: "p_cal" + Date.now() });
    await pause(300);
    assert.strictEqual(tableOf(a), "tea", "the tea pavilion to begin with");
    assert.strictEqual(last.get(a).room.players[last.get(a).room.hostSeat].plus, true, "the host's seat says Plus");
    ok("a Plus room begins at the tea-estate pavilion");

    c.emit("look", { slot: "rummy", id: "diwali" });
    await pause(300);
    assert.strictEqual(tableOf(a), "tea", "a guest's pick is not the table's");
    ok("only the host picks the table");

    a.emit("look", { slot: "rummy", id: "diwali" });
    await pause(300);
    assert.strictEqual(tableOf(a), "diwali");
    assert.strictEqual(tableOf(c), "diwali", "the guest's app is told too");
    ok("the host's pick reaches every app: the Diwali rooftop");

    a.emit("look", { slot: "rummy", id: "desert" });
    await pause(300);
    assert.strictEqual(tableOf(c), "desert", "and the desert camp");
    a.emit("look", { slot: "rummy", id: "garden" });
    a.emit("look", { slot: "ball", id: "gold" });
    a.emit("look", { slot: "snakes", id: "pharaoh" });
    a.emit("look");
    a.emit("look", { slot: "rummy" });
    await pause(300);
    assert.strictEqual(tableOf(a), "desert");
    const host = last.get(a).room.players[last.get(a).room.hostSeat];
    assert.strictEqual(host.look.ball, "classic", "a ball is not a table's slot");
    ok("an id outside the list, a slot that is not a table's and a bare event change nothing");

    a.emit("look", { slot: "rummy", id: "tea" });
    await pause(300);
    assert.strictEqual(tableOf(a), "tea", "and back again");
    a.emit("look", { slot: "rummy", id: "diwali" });
    await pause(300);
    a.emit("addBot");
    await pause(200);
    a.emit("start");
    await pause(400);
    assert.strictEqual(last.get(a).room.status, "playing");
    a.emit("look", { slot: "rummy", id: "desert" });
    await pause(300);
    assert.strictEqual(tableOf(a), "diwali", "not once the game has started");
    ok("the table is set when the game starts");

    // A room without Plus has one table.
    const f = client();
    watch(f);
    f.emit("create", { name: "Fay", playerId: "p_fay" + Date.now() });
    await pause(300);
    f.emit("look", { slot: "rummy", id: "diwali" });
    await pause(300);
    assert.strictEqual(tableOf(f), "tea", "no Plus, no second table");
    assert.strictEqual(last.get(f).room.players[last.get(f).room.hostSeat].plus, false, "and its host's seat says no Plus");
    ok("a room without Plus has the tea pavilion alone");
  } finally {
    for (const s of socks) s.close();
    srv.kill();
  }
  console.log(`plus look: ${passed} ok`);
}
main().catch((e) => { console.error(e); process.exit(1); });
