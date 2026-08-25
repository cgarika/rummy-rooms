/* Browser-level UI suite (Playwright) against the LIVE deployment.
   Run from test/:  node ui-test.js        (BASE=https://needasix.com/rummy by default)
   Screenshots land in $SHOTS or test/shots.

   Covers:
   1. Lobby UI: create room, Add/Remove bot buttons, Deal enables at 2+ players
   2. Real turns vs a bot through clicks: draw from the closed pile AND the open
      pile, select + discard, the just-picked-open-card discard block, grouping
      via Group ▸ new with server-side persistence. (A 13-card game to a valid
      declare can run long against a live-speed bot, so this exercises the full
      turn loop rather than racing to a winner — the rules suite already proves
      games complete.)
   3. Voice: two contexts with fake mics join voice, WebRTC reaches "connected",
      mute toggles track.enabled, leave tears down cleanly
   4. Mobile pass (iPhone 13 portrait): overflow audit, draw/discard by touch
*/
const { chromium, devices } = require("playwright");
const fs = require("fs");
const BASE = process.env.BASE || "https://needasix.com/rummy";
const SHOTS = process.env.SHOTS || __dirname + "/shots";
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
let cur = null;
const ok = (m) => console.log("  ✓", m);
const bad = (m) => { console.log("  ✗", m); cur.errors.push(m); process.exitCode = 1; };
const flag = (m) => { console.log("  ⚑", m); cur.flags.push(m); };

async function test(title, fn) {
  cur = { title, errors: [], flags: [] };
  console.log("\n▶ " + title);
  const t0 = Date.now();
  try { await fn(); } catch (e) { bad("EXCEPTION: " + e.message.split("\n")[0]); }
  cur.secs = ((Date.now() - t0) / 1000).toFixed(1);
  results.push(cur);
}

(async () => {
  const browser = await chromium.launch({
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  });

  const mkPage = async (name, ctxOpts = {}, { mic = false } = {}) => {
    const ctx = await browser.newContext({ viewport: { width: 900, height: 1000 }, reducedMotion: "reduce", ...ctxOpts });
    if (mic) await ctx.grantPermissions(["microphone"], { origin: new URL(BASE).origin });
    const pg = await ctx.newPage();
    pg.on("pageerror", (e) => bad(`${name} JS error: ${e.message}`));
    pg.on("dialog", (d) => d.accept());
    pg._name = name;
    return pg;
  };
  const createRoom = async (pg, name) => {
    await pg.goto(BASE, { waitUntil: "networkidle", timeout: 60000 });
    await pg.fill("#nameIn", name);
    await pg.click("#createBtn");
    await pg.waitForSelector("#lobby:not(.hidden)", { timeout: 10000 });
    return (await pg.textContent("#lobbyCode")).replace(/[^A-Z0-9]/g, "");
  };
  const joinRoom = async (pg, name, code) => {
    await pg.goto(BASE, { waitUntil: "networkidle", timeout: 60000 });
    await pg.fill("#nameIn", name);
    await pg.fill("#codeIn", code);
    await pg.click("#joinBtn");
    await pg.waitForSelector("#lobby:not(.hidden)", { timeout: 10000 });
  };
  const snap = (pg) => pg.evaluate(() => ({
    status: S.room.status, phase: S.room.phase, turn: S.room.turn, mySeat: S.mySeat,
    hand: (S.room.yourHand || []).map((c) => c.id), groups: (S.room.yourGroups || []).length,
    picked: S.room.pickedOpenId, openTop: (S.room.openTop || []).length, closed: S.room.closedCount,
  }));
  const myDrawTurn = (st) => st.status === "playing" && st.turn === st.mySeat && st.phase === "draw";
  const waitTurn = async (pg, phase, capMs) => {
    const t0 = Date.now();
    while (Date.now() - t0 < capMs) {
      const st = await snap(pg);
      if (st.status !== "playing") return null;
      if (st.turn === st.mySeat && st.phase === phase) return st;
      await pg.waitForTimeout(300);
    }
    return null;
  };

  /* ---- 1 + 2 share one room: host page A ---- */
  const A = await mkPage("Alice");

  await test("1. Lobby: create room, bot buttons, Deal enables at 2+", async () => {
    const code = await createRoom(A, "Alice");
    /^[A-Z0-9]{4,8}$/.test(code) ? ok(`room ${code} created`) : bad("bad room code: " + code);

    (await A.getAttribute("#startBtn", "disabled")) !== null
      ? ok("Deal disabled with 1 player") : bad("Deal enabled with only 1 player");

    await A.click("#addBotBtn");
    await A.waitForFunction(() => S.room.players.length === 2, null, { timeout: 5000 });
    const row = await A.textContent("#plist");
    row.includes("(bot)") ? ok('bot row shows "(bot)" suffix') : bad('bot row missing "(bot)": ' + row.trim());
    row.includes("\u{1F916}") ? ok("bot row shows 🤖 avatar") : bad("bot row missing 🤖 avatar");
    (await A.getAttribute("#startBtn", "disabled")) === null
      ? ok("Deal enables at 2 players") : bad("Deal still disabled at 2 players");

    await A.waitForSelector("#delBotBtn", { timeout: 3000 });
    await A.click("#delBotBtn");
    await A.waitForFunction(() => S.room.players.length === 1, null, { timeout: 5000 });
    ok("Remove bot removes the bot (back to 1 player)");
    (await A.$("#delBotBtn")) ? bad("Remove bot button still shown with no bots") : ok("Remove bot button hides when no bots remain");
  });

  await test("2. Turns vs a bot: closed + open draws, discard rules, grouping persists", async () => {
    await A.click("#addBotBtn");
    await A.waitForFunction(() => S.room.players.length === 2, null, { timeout: 5000 });
    await A.click("#startBtn");
    await A.waitForSelector("#game:not(.hidden)", { timeout: 10000 });
    await A.waitForFunction(() => (S.room.yourHand || []).length === 13, null, { timeout: 10000 });
    ok("dealt: 13 cards in hand, game screen up");
    (await A.textContent("#wildline")).includes("wild") ? ok("wildcard line announces the joker rank") : bad("wildline missing");

    // turn 1: draw from the CLOSED pile, then discard a selected card
    let st = await waitTurn(A, "draw", 30000);
    if (!st) return bad("never got a draw turn");
    await A.click("#drawpile");
    await A.waitForFunction(() => (S.room.yourHand || []).length === 14, null, { timeout: 6000 });
    ok("closed-pile draw: hand 13 → 14");
    st = await snap(A);
    const looseCard = await A.$("#loose .pc[data-i]");
    await looseCard.click();
    await A.waitForSelector("#loose .pc.sel", { timeout: 4000 });
    ok("card click selects it (highlight)");
    (await A.getAttribute("#discardBtn", "disabled")) === null
      ? ok("Discard enables with one card selected") : bad("Discard stayed disabled with a selection");
    await A.click("#discardBtn");
    await A.waitForFunction(() => (S.room.yourHand || []).length === 13, null, { timeout: 6000 });
    ok("discard: hand back to 13, turn passes");
    await A.screenshot({ path: SHOTS + "/midgame.png" });

    // turn 2: draw from the OPEN pile; the picked card must refuse to be discarded
    st = await waitTurn(A, "draw", 40000);
    if (!st) return bad("no second draw turn");
    if (st.openTop > 0) {
      await A.click("#openTop");
      await A.waitForFunction(() => (S.room.yourHand || []).length === 14, null, { timeout: 6000 });
      ok("open-pile draw: took the visible top card");
      const picked = (await snap(A)).picked;
      await A.evaluate(() => document.querySelectorAll(".pc.sel").forEach((c) => c.click())); // clear selection
      await A.click(`.pc[data-i="${picked}"]`);
      await A.waitForFunction((p) => document.querySelector(`.pc.sel[data-i="${p}"]`) !== null, picked, { timeout: 4000 });
      (await A.getAttribute("#discardBtn", "disabled")) !== null
        ? ok("just-picked open card cannot be discarded (button disabled)") : bad("discard allowed for the just-picked open card");
      // pick a different card and discard legally
      await A.click(`.pc[data-i="${picked}"]`); // deselect
      const other = (await snap(A)).hand.find((id) => id !== picked);
      await A.click(`.pc[data-i="${other}"]`);
      await A.waitForFunction(() => document.getElementById("discardBtn").disabled === false, null, { timeout: 4000 });
      await A.click("#discardBtn");
      await A.waitForFunction(() => (S.room.yourHand || []).length === 13, null, { timeout: 6000 });
      ok("discarded a different card instead");
    } else flag("open pile was empty on the second turn — open-draw branch skipped");

    // grouping: select two cards → Group ▸ new → server keeps the arrangement
    const before = (await snap(A)).groups;
    const ids = (await snap(A)).hand.slice(0, 2);
    for (const id of ids) await A.click(`.pc[data-i="${id}"]`);
    await A.click("#groupBtn");
    await A.waitForFunction((n) => (S.room.yourGroups || []).length === n + 1, before, { timeout: 5000 });
    ok("Group ▸ new creates a group; arrangement persisted by the server");
    (await A.$$("#groupsBox .grp")).length >= 1 ? ok("group renders in the hand area with a validity tag") : bad("no .grp rendered");

    await A.click("#leaveGameBtn");
    await A.waitForSelector("#home:not(.hidden)", { timeout: 6000 });
    ok("left the game back to home");
    await A.context().close();
  });

  await test("3. Voice: 2 players connect, mute toggles track, leave tears down", async () => {
    const V1 = await mkPage("Vera", {}, { mic: true });
    const V2 = await mkPage("Wade", {}, { mic: true });
    const code = await createRoom(V1, "Vera");
    await joinRoom(V2, "Wade", code);
    await V1.waitForFunction(() => S.room.players.length === 2, null, { timeout: 8000 });
    await V1.click("#startBtn");
    await V1.waitForSelector("#voicebar:not(.hidden)", { timeout: 10000 });
    await V2.waitForSelector("#voicebar:not(.hidden)", { timeout: 10000 });
    ok("voice bar visible on both players once the cards are dealt");

    await V1.click("#voiceBtn");
    await V1.waitForFunction(() => VOICE.on === true, null, { timeout: 8000 });
    await V2.click("#voiceBtn");
    for (const P of [V1, V2]) {
      await P.waitForFunction(() => document.getElementById("voicewho").textContent.includes("2 in voice"), null, { timeout: 15000 });
      ok(`${P._name}: bar shows "2 in voice"`);
    }
    for (const P of [V1, V2]) {
      await P.waitForFunction(
        () => VOICE.pcs.size >= 1 && [...VOICE.pcs.values()].every((pc) => pc.connectionState === "connected"),
        null, { timeout: 30000 }
      ).then(
        () => ok(`${P._name}: RTCPeerConnection reached connectionState "connected"`),
        async () => bad(`${P._name}: WebRTC never connected — states: ` +
          await P.evaluate(() => JSON.stringify([...VOICE.pcs.values()].map((pc) => pc.connectionState))))
      );
    }
    await V1.screenshot({ path: SHOTS + "/voice-connected.png" });

    await V1.click("#voiceBtn"); // now toggles mute
    await V1.waitForFunction(() => VOICE.muted === true, null, { timeout: 5000 });
    (await V1.evaluate(() => VOICE.stream.getAudioTracks().every((t) => t.enabled === false)))
      ? ok("Mute disables the local audio track (track.enabled=false)") : bad("mute did not disable the track");
    (await V1.textContent("#voiceBtn")).includes("Unmute") ? ok('button relabels to "Unmute"') : bad("mute button label wrong");
    await V1.click("#voiceBtn");
    await V1.waitForFunction(() => VOICE.muted === false, null, { timeout: 5000 });
    (await V1.evaluate(() => VOICE.stream.getAudioTracks().every((t) => t.enabled === true)))
      ? ok("Unmute re-enables the track") : bad("unmute did not re-enable the track");

    await V1.click("#voiceLeave");
    await V1.waitForFunction(() => !VOICE.on && VOICE.pcs.size === 0 && VOICE.stream === null, null, { timeout: 5000 });
    ok("leave voice: local peer map cleared, mic stream stopped");
    (await V1.textContent("#voiceBtn")).includes("Join voice") ? ok('button back to "Join voice"') : bad("leave label wrong");
    await V2.waitForFunction(() => document.getElementById("voicewho").textContent.includes("1 in voice"), null, { timeout: 8000 });
    await V2.waitForFunction(() => VOICE.pcs.size === 0, null, { timeout: 8000 });
    ok('other player sees "1 in voice" and drops the dead peer connection');

    await V2.click("#voiceLeave").catch(() => {});
    for (const P of [V1, V2]) await P.click("#leaveGameBtn").catch(() => {});
    await V1.context().close(); await V2.context().close();
  });

  await test("4. Mobile pass: iPhone 13 portrait, overflow audit, draw/discard by touch", async () => {
    const iphone = devices["iPhone 13"];
    const ctx = await browser.newContext({ ...iphone, reducedMotion: "reduce" });
    const M = await ctx.newPage();
    M.on("pageerror", (e) => bad(`mobile JS error: ${e.message}`));
    M.on("dialog", (d) => d.accept());

    const audit = async (stage) => {
      const issues = await M.evaluate((devW) => {
        const out = [];
        // rapid taps can trigger double-tap zoom in mobile emulation; geometry vs the
        // visual viewport is meaningless then, so measure only at the device's true width
        if (Math.abs(window.innerWidth - devW) > 2) return ["ZOOMED:" + window.innerWidth];
        const W = window.innerWidth, de = document.documentElement;
        if (de.scrollWidth > W + 1) out.push(`page overflows horizontally: ${de.scrollWidth}px > ${W}px viewport`);
        const sels = "button, input, .pc, .avchip, .chattoggle, .sendbtn, #voiceLeave, #drawpile, #openTop";
        for (const el of document.querySelectorAll(sels)) {
          if (el.classList.contains("hidden") || el.closest(".hidden") || el.offsetParent === null) continue;
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) continue;
          const name = `<${el.tagName.toLowerCase()}${el.id ? "#" + el.id : "." + ((el.getAttribute("class") || "").split(" ")[0] || "")}>`;
          if (r.width < 24 || r.height < 24) out.push(`tap target under 24px: ${name} ${Math.round(r.width)}x${Math.round(r.height)}`);
          if (r.left < -1 || r.right > W + 1) {
            let scrollable = false;
            for (let a = el.parentElement; a; a = a.parentElement) {
              const cs = getComputedStyle(a);
              if ((cs.overflowX === "auto" || cs.overflowX === "scroll") && a.scrollWidth > a.clientWidth + 1) { scrollable = true; break; }
            }
            if (!scrollable) out.push(`control clipped horizontally: ${name} ${Math.round(r.left)}..${Math.round(r.right)} (viewport ${W})`);
          }
        }
        return out;
      }, iphone.viewport.width);
      if (issues[0] && issues[0].startsWith("ZOOMED:")) {
        flag(`[${stage}] audit skipped — page zoomed by double-tap during play (innerWidth ${issues[0].slice(7)}px)`);
        return;
      }
      issues.length ? issues.forEach((i) => flag(`[${stage}] ${i}`)) : ok(`[${stage}] no overflow, tap targets ≥24px`);
    };
    const tryTap = (sel) => M.tap(sel, { timeout: 2500 }).then(() => true, () => false);

    await M.goto(BASE, { waitUntil: "networkidle", timeout: 60000 });
    await audit("home");
    await M.fill("#nameIn", "Mia");
    await M.tap("#createBtn");
    await M.waitForSelector("#lobby:not(.hidden)", { timeout: 10000 });
    await M.tap("#addBotBtn");
    await M.waitForFunction(() => S.room.players.length === 2, null, { timeout: 5000 });
    ok("create + bot by touch");
    await audit("lobby");
    await M.tap("#startBtn");
    await M.waitForSelector("#game:not(.hidden)", { timeout: 10000 });
    await M.waitForFunction(() => (S.room.yourHand || []).length === 13, null, { timeout: 10000 });
    ok("Deal by touch → 13 cards rendered");

    let cycles = 0;
    const stop = Date.now() + 60000;
    while (Date.now() < stop && cycles < 2) {
      const st = await snap(M);
      if (st.status !== "playing") break;
      if (st.turn !== st.mySeat) { await M.waitForTimeout(400); continue; }
      if (st.phase === "draw") { await tryTap("#drawpile"); await M.waitForTimeout(600); continue; }
      if (st.phase === "discard") {
        const id = st.hand.find((i) => i !== st.picked);
        await M.evaluate(() => document.querySelectorAll(".pc.sel").forEach((c) => c.click()));
        if (await tryTap(`.pc[data-i="${id}"]`)) {
          const enabled = await M.waitForFunction(() => document.getElementById("discardBtn").disabled === false, null, { timeout: 3000 }).then(() => true, () => false);
          if (enabled && await tryTap("#discardBtn")) cycles++;
        }
        await M.waitForTimeout(600);
      }
    }
    cycles >= 1 ? ok(`draw + select + discard by touch (${cycles} full turns)`) : bad("no full draw/discard turn landed by touch");
    await audit("mid-game");
    await M.screenshot({ path: SHOTS + "/mobile-midgame.png" });
    await M.tap("#leaveGameBtn").catch(() => {});
    await ctx.close();
  });

  await browser.close();
  console.log("\n════════ UI SUITE SUMMARY ════════");
  for (const r of results)
    console.log(` ${r.errors.length ? "FAIL" : "PASS"}${r.flags.length ? "⚑" : ""}  ${r.title}  (${r.secs}s)` +
      (r.errors.length ? "\n        " + r.errors.join("\n        ") : "") +
      (r.flags.length ? "\n        flags: " + r.flags.join("; ") : ""));
  const failed = results.filter((r) => r.errors.length).length;
  console.log(failed ? `\n=== RESULT: FAIL (${failed} of ${results.length}) ===` : "\n=== RESULT: PASS ===");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
