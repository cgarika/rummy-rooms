const http = require("http");
const path = require("path");
const crypto = require("crypto");
const Reactions = require("./reactions");   // the cartoon stickers (2026-10-15)
const Quick = require("./quickmatch");   // quick play and ranked (2026-10-24)
const Plus = require("./plus");   // GameNest Plus: the room's flag and each player's look (2026-10-16)
const Moderation = require("./moderation");   // what players type, kept friendly (2026-10-18)
/* The bots' three levels (2026-11-13): easy, normal (the bot as it has always played) and sharp. bots.js plays on this
   file's own engine, so it is handed the functions below. */
const Bots = require("./bots")({ isJoker, cardPoints, botDiscardCard, botFinishCard, botWantsOpen, deadwood });

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
function hasThreeInARow(cards) {
  const have = { S: 0, H: 0, D: 0, C: 0 };
  for (const c of cards) if (have[c.s] !== undefined && c.r >= 1 && c.r <= 13) have[c.s] |= (1 << c.r) | (c.r === 1 ? 1 << 14 : 0);
  for (const s of "SHDC") { const b = have[s]; if (b & (b >> 1) & (b >> 2)) return true; }
  return false;
}
function bestArrangement(cards, wildRank, cap) {
  cap = cap || 60000;
  let nodes = 0;
  const jokers = cards.filter((c) => isJoker(c, wildRank));
  const jokerFace = jokers.map((c) => c.s + ":" + c.r);
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
        // Jokers may also extend a run too short on its own (4S 5S + a joker): the extras bring it to three or more.
        if (total <= 5) {
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
      /* Which joker goes to which meld matters: a wild card can sit in its own natural
         place and keep a sequence pure (wild 4 in 4S 5S 6S), which it cannot do from
         another suit's run. Handed out in order, a winning hand could find no pure
         sequence at all; so every way of dealing the jokers to the melds is tried (the
         jokers are few, the ways fewer still). */
      const taken = new Array(jokers.length).fill(false);
      /* Two cuts that skip only what cannot win (2026-11-13; with eight jokers in a hand the ways were millions and
         one bot turn took seconds). A dead end is remembered: from one meld on, with the same jokers taken and the
         same sequences made, the answer is the same. And of two jokers with one face only the first free one is
         tried: the other could do nothing else. The arrangement found is the one found before, card for card. */
      let takenBits = 0;
      const dead = new Set();
      const place = (mi, groups, seqs, pures) => {
        if (mi === all.length) return pures >= 1 && seqs >= 2 ? groups : null;
        const deadKey = ((takenBits * 16 + mi) * 4 + Math.min(seqs, 3)) * 2 + Math.min(pures, 1);
        if (dead.has(deadKey)) return null;
        const m = all[mi];
        const cs = m.idxs.map((i) => plain[i]);
        const pickJ = (start, chosen) => {
          if (chosen.length === m.j) {
            const cards2 = cs.concat(chosen.map((k) => jokers[k]));
            const v = validMeld(cards2, wildRank);
            if (!v.valid) return null;
            chosen.forEach((k) => { taken[k] = true; takenBits |= 1 << k; });
            const got = place(mi + 1, groups.concat([cards2.map((c) => c.id)]), seqs + (v.type === "seq" || v.type === "pure" ? 1 : 0), pures + (v.type === "pure" ? 1 : 0));
            chosen.forEach((k) => { taken[k] = false; takenBits &= ~(1 << k); });
            return got;
          }
          for (let k = start; k < jokers.length; k++) {
            if (taken[k]) continue;
            let twin = false;
            for (let p = 0; p < k && !twin; p++) twin = !taken[p] && jokerFace[p] === jokerFace[k] && !chosen.includes(p);
            if (twin) continue;
            const got = pickJ(k + 1, chosen.concat([k]));
            if (got) return got;
          }
          return null;
        };
        const got = pickJ(0, []);
        if (!got) dead.add(deadKey);
        return got;
      };
      const groups = place(0, [], 0, 0);
      return groups ? { groups } : null;
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
  /* No three cards in a row in one suit (a wild card counts as the card it is), so no pure sequence and no declare:
     said at once, instead of after every arrangement has been tried. A hand full of jokers is the usual case. */
  if (!hasThreeInARow(cards)) return null;
  return dfs(0n, 0, jokers.length, []);
}

/* =========================================================
   SERVER
   ========================================================= */
/* ---------- T11: deadwood evaluation for the bot ----------
   deadwood = points of the cards left outside the best disjoint collection of valid melds.
   Candidate melds are built directly (sets by rank, runs by suit, jokers filling holes) and each one is
   confirmed with validMeld; a capped DFS then picks the disjoint collection that melds the most points. */
/* The bot asks about the same hands several times a turn (the open card's test, the finish test and the discard
   all try the hand without each card), so answers are remembered by the cards' faces and the wild rank. */
const DEADWOOD_MEMO = new Map();
const SUIT_CODE = { S: 1, H: 2, D: 3, C: 4, J: 5 };
function deadwood(cards, wildRank, cap) {
  const codes = new Array(cards.length + 1);
  codes[0] = 1 + (wildRank | 0);
  for (let i = 0; i < cards.length; i++) codes[i + 1] = (SUIT_CODE[cards[i].s] || 6) * 16 + (cards[i].r | 0);
  codes.sort((a, b) => a - b);
  const key = String.fromCharCode.apply(null, codes) + (cap ? "|" + cap : "");
  let v = DEADWOOD_MEMO.get(key);
  if (v === undefined) {
    v = deadwoodOf(cards, wildRank, cap);
    if (DEADWOOD_MEMO.size >= 4096) DEADWOOD_MEMO.clear();
    DEADWOOD_MEMO.set(key, v);
  }
  return v;
}
function deadwoodOf(cards, wildRank, cap) {
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
  /* Branch and bound (exact; it only skips what cannot win): from meld k on, a collection can add at most the points
     of the cards melds k.. still cover. suf[k] is their union, so a branch whose bound is no better than the best
     found stops, and everything stops once every point is melded. */
  const suf = new Array(melds.length + 1);
  suf[melds.length] = 0;
  for (let i = melds.length - 1; i >= 0; i--) suf[i] = suf[i + 1] | melds[i].mask;
  const lo = new Array(128).fill(0), hi = new Array(128).fill(0);   // points of any mask, by its two 7-bit halves
  for (let m = 1; m < 128; m++) { const b = 31 - Math.clz32(m), r = m & ~(1 << b); lo[m] = lo[r] + (pts[b] || 0); hi[m] = hi[r] + (pts[b + 7] || 0); }
  const ptsIn = (mask) => lo[mask & 127] + hi[(mask >>> 7) & 127];
  let best = 0, nodes = 0;
  const go = (k, mask, jUsed, acc) => {
    if (acc > best) best = acc;
    if (best === total) return;
    if (++nodes > cap) return;
    for (let i = k; i < melds.length; i++) {
      if (acc + ptsIn(suf[i] & ~mask) <= best) return;   // melds i.. cannot beat the best: nor can any later start
      const m = melds[i];
      if (m.mask & mask) continue;
      const usedAsNatural = popcount((mask | m.mask) & jokerBits);
      if (jUsed + m.j > nJokers - usedAsNatural) continue;
      go(i + 1, mask | m.mask, jUsed + m.j, acc + m.v);
      if (best === total || nodes > cap) return;
    }
  };
  go(0, 0, 0, 0);
  return total - best;
}
function popcount(x) { let c = 0; while (x) { x &= x - 1; c++; } return c; }
/* the discard that leaves the lowest deadwood (ties: dump the higher card); never the card just picked up */
function botDiscardCard(hand, wildRank, pickedOpenId) {
  let best = null, bestDw = Infinity;
  for (const c of hand) {
    if (c.id === pickedOpenId) continue;
    const dw = deadwood(hand.filter((x) => x.id !== c.id), wildRank);
    if (dw < bestDw || (dw === bestDw && cardPoints(c, wildRank) > cardPoints(best, wildRank))) { bestDw = dw; best = c; }
  }
  return best || hand.find((c) => c.id !== pickedOpenId) || hand[0];
}
/* every finish card is tried: the first whose remaining 13 has zero deadwood AND validates as a declare */
function botFinishCard(hand, wildRank, pickedOpenId) {
  for (const c of hand) {
    if (c.id === pickedOpenId) continue;
    const kept = hand.filter((x) => x.id !== c.id);
    if (kept.length !== 13 || deadwood(kept, wildRank) !== 0) continue;
    const win = bestArrangement(kept, wildRank, 30000);
    if (win) return { id: c.id, groups: win.groups };
  }
  return null;
}
/* take the open card only when it lowers deadwood (after the best discard that is not the card itself) */
function botWantsOpen(hand, top, wildRank) {
  if (!top || isJoker(top, wildRank)) return false;
  const now = deadwood(hand, wildRank);
  const withTop = hand.concat([top]);
  let best = Infinity;
  for (const c of hand) { const dw = deadwood(withTop.filter((x) => x.id !== c.id), wildRank); if (dw < best) best = dw; }
  return best < now;
}

/* GN-30: one name cap for every game, 18 UTF-16 units (as the app counts), cut only between whole characters as a
   reader sees them (grapheme clusters), so a name never ends in half an emoji or a flag's lone letter. An avatar is
   one such character (a sticker; a family with skin tones is about 20 units). */
const NAME_MAX = 18, AVATAR_MAX = 24;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function capText(s, max, oneOnly) {
  s = String(s == null ? "" : s).slice(0, 4096).replace(/[<>]/g, "").trim();
  let out = "";
  for (const { segment } of graphemes.segment(s)) {
    if (out.length + segment.length > max) break;
    out += segment;
    if (oneOnly) break;
  }
  return out.trim();
}
const capName = (s) => capText(s, NAME_MAX);
const capAvatar = (s) => capText(s, AVATAR_MAX, true);
/* What this server can do beyond what today's app knows, so a newer client can tell before it relies on it. */
const FEATURES = Object.freeze(["refusalCodes", "serverNow", "waitList", "reactions", "botLevels"]);

/* Every client event goes through one guard (as in Nightfall and Word Spies, less their flood limit). A payload that
   is not an object (null, a number, a string, an array) arrives as {}: 42["join",null] used to throw inside the
   handler's destructuring and stop the whole process, every room with it. A handler that still throws is logged and
   the server carries on. */
function guarded(socket) {
  return (event, fn) => socket.on(event, (payload, ...rest) => {
    try { fn(payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {}, ...rest); }
    catch (e) { console.error(`[${new Date().toISOString()}] ${event} failed:`, (e && e.stack) || e); }
  });
}

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
  app.get("/internal/roster/:code", Plus.rosterHandler((code) => rooms.get(code)));   // who is at a table, for the wallet's Treat the room (404 without GN_INTERNAL_SECRET)
  /* GameNest Plus: a player says on create and join that they own Plus; a room
     whose host owns it is a Plus room, and every client shows its extras.
     The client's word is taken for now (checking Apple's receipt is a later step). */
  function stampPlus(code, socket, said) {
    const room = rooms.get(code);
    const p = room && socket && socket.data && room.players.find((q) => q.id === socket.data.playerId);
    if (p) { Plus.stampFor(p, said, socket); Plus.dedupe(room, p); }
  }
  const roomSockets = new Map();
  const timers = new Map();
  const botTimers = new Map();

  const newId = () => crypto.randomBytes(8).toString("hex");
  const newCode = () => {
    const A = "ABCDEFGHJKMNPRTWXYZ";
    let c = "";
    for (let i = 0; i < 6; i++) c += A[crypto.randomInt(A.length)];
    return rooms.has(c) ? newCode() : c;
  };
  const BOT_NAMES = ["Robo", "Chip", "Bolt", "Turbo", "Pixel", "Gizmo"];
  const clean = (s, n) => String(s || "").replace(/[<>]/g, "").trim().slice(0, n);
  /* GN-05: every refusal names its reason for machines as well as people: a "refusal" event { code, message, op }
     first, then "err" as today with the English first and { code, op } after it (codes: not_found, started, full,
     name_required, not_enough_players, and for moves joker_from_open, pile_empty, not_your_drop, picked_card; the
     same names as the other GameNest servers). */
  function refuse(socket, code, message, op) { socket.emit("refusal", { code, message, op }); socket.emit("err", message, { code, op }); }

  function clearT(map, code) { const t = map.get(code); if (t) { clearTimeout(t); map.delete(code); } }
  function deleteRoom(code) { clearT(timers, code); clearT(botTimers, code); clearBotWatch(code); rooms.delete(code); roomSockets.delete(code); }

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
    room.players.forEach((p) => { p.left = p.left || false; p.out = !!p.pooledOut; p.dropPoints = 0; });   // T15: pooled-out players sit this one out
    room.totalsById = room.totalsById || {};
    room.hands = room.players.map(() => []);
    room.drew = room.players.map(() => 0);   // T7: turns on which each seat drew a card (first-turn drop = 20, later = 40)
    room.groups = room.players.map(() => []);
    room.mem = Bots.memory(room.players.length);   // what the table has seen thrown and taken, for the sharp bots; never in a state
    for (let k = 0; k < 13; k++)
      for (let i = 0; i < room.players.length; i++)
        if (!room.players[i].left && !room.players[i].out) room.hands[i].push(deck.pop());
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
      if (isJoker(room.open[room.open.length - 1], room.wildRank)) return false;   // T7: jokers can't be picked up from the open pile
      const c = room.open.pop();
      room.hands[seat].push(c);
      room.pickedOpenId = c.id;
      Bots.noteDraw(room.mem, seat, "open", c, null);
      room.lastMove = { seat, kind: "drawOpen", card: c };
      room.log = `${room.players[seat].name} picked up the ${cardName(c)}.`;
    } else {
      reshuffleIfNeeded(room);
      if (room.closed.length === 0) return false;
      const c = room.closed.pop();
      room.hands[seat].push(c);
      room.lastMove = { seat, kind: "draw" };
      Bots.noteDraw(room.mem, seat, "closed", null, room.open[room.open.length - 1]);   // the face-up card they left lying
      room.log = `${room.players[seat].name} drew from the closed pile.`;
    }
    if (room.drew) room.drew[seat] = (room.drew[seat] || 0) + 1;
    room.phase = "discard";
    return true;
  }

  /* T7: drop — give up the hand before drawing. 20 points on your first turn, 40 after that. */
  function dropPointsFor(room, seat) { return room.drew && room.drew[seat] ? 40 : 20; }
  function doDrop(room, seat) {
    if (room.phase !== "draw" || room.turn !== seat) return false;
    const p = room.players[seat];
    if (!p || p.out || p.left) return false;
    const pts = dropPointsFor(room, seat);
    p.out = true; p.dropPoints = pts;
    room.lastMove = { seat, kind: "drop" };
    room.log = `${p.name} dropped for ${pts} points.`;
    Reactions.event(room, seat, "bad", bump);   // the bots' reactions (2026-10-15)
    const act = activeSeats(room);
    if (act.length === 1) {
      finishGame(room, act[0]);
      room.log = `${room.players[act[0]].name} is the last one standing — they win!`;
    } else nextTurn(room);
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
    Bots.noteDiscard(room.mem, seat, c);
    room.log = `${room.players[seat].name} discarded the ${cardName(c)}.`;
    nextTurn(room);
    return true;
  }

  function finishGame(room, declarerSeat) {
    Reactions.event(room, declarerSeat, "win", bump);   // the bots' reactions (2026-10-15)
    room.status = "over";
    room.phase = "over";
    room.winner = declarerSeat;
    /* A sharp bot keeps its hand grouped (bots.js), so a loss costs it only its loose cards, as it costs a person who
       grouped theirs. Easy and normal bots lose as they always have: every card of theirs counts. */
    if (Bots.level(room.botLevel) === "sharp") room.players.forEach((p, i) => {
      if (!p.bot || p.left || p.out || p.pooledOut || i === declarerSeat || !room.hands[i] || room.hands[i].length !== 13) return;
      try { const g = Bots.groups("sharp", room.hands[i], room.wildRank); if (g) room.groups[i] = g; } catch (_) {}
    });
    room.results = room.players.map((p, i) => {
      if (p.pooledOut) return { seat: i, points: 0, sat: true };
      if (i === declarerSeat) return { seat: i, points: 0, declared: true };
      if (p.out && p.dropPoints) return { seat: i, points: p.dropPoints, dropped: true };
      if (p.out) return { seat: i, points: 80, wrong: true };
      if (p.left) return { seat: i, points: 40, left: true };   // T7: leaving mid-game costs a middle drop, not a wrong declare
      return { seat: i, points: scoreHand(room.hands[i], room.groups[i], room.wildRank) };
    }).sort((a, b) => a.points - b.points);
    room.log = `${room.players[declarerSeat].name} declared — VALID! ${room.players[declarerSeat].name.toUpperCase()} WINS! 🎉`;
    // T15: running totals across deals; in a pool game a player is out once they cross the pool, last one standing wins the match
    room.totalsById = room.totalsById || {};
    for (const r of room.results) { const p = room.players[r.seat]; if (!p.left && !r.sat) room.totalsById[p.id] = (room.totalsById[p.id] || 0) + r.points; r.total = room.totalsById[p.id] || 0; }
    if (room.pool) {
      const crossed = [];
      for (const p of room.players) if (!p.left && !p.pooledOut && (room.totalsById[p.id] || 0) >= room.pool) { p.pooledOut = true; crossed.push(p.name); }
      if (crossed.length) room.log += ` ${crossed.join(" and ")} crossed the ${room.pool} pool and ${crossed.length === 1 ? "is" : "are"} out.`;
      const inPlay = room.players.filter((p) => !p.left && !p.pooledOut);
      if (inPlay.length === 1) { room.champion = room.players.indexOf(inPlay[0]); room.log += ` ${inPlay[0].name} wins the pool! 🏆`; }
    }
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
    Bots.noteDiscard(room.mem, seat, fc);
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
      pool: room.pool || 0, totals: room.players.map((p) => (room.totalsById && room.totalsById[p.id]) || 0), champion: room.champion ?? null,
      hostSeat: room.players.findIndex((p) => p.id === room.host),
      lastMove: room.lastMove, phaseEndsAt: room.phaseEndsAt || null,
      maxPlayers: MAX_PLAYERS,
      players: room.players.map((p, i) => ({
        name: p.name, avatar: p.avatar, ...Plus.seat(p), bot: !!p.bot, botControlled: !!p.botControlled, left: p.left, out: !!p.out, connected: p.connected, pooledOut: !!p.pooledOut,
        count: room.hands && room.hands[i] ? room.hands[i].length : 0,
      })),
      yourHand: room.hands && seat >= 0 && room.hands[seat] ? room.hands[seat] : [],
      yourGroups: room.groups && seat >= 0 && room.groups[seat] ? room.groups[seat] : [],
      pickedOpenId: seat === room.turn ? room.pickedOpenId : null,
      voice: room.voice ? Array.from(room.voice) : [],
      chat: (room.chat || []).slice(-60),
      /* new, after every old field (today's app ignores them) */
      features: FEATURES,
      serverNow: Date.now(),   // GN-48: the server's clock, so a phone whose clock is off can correct phaseEndsAt
      ...Reactions.view(room),   // 2026-10-15: reactionsOn and the last reactions
      ...Quick.view(room),   // quick play and ranked (2026-10-24)
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

/* ---------- the waiting line (the owner, 2026-09-29) ----------
   Someone who joins a game already under way (and whose app says "waitList") waits in line,
   watching. A seat someone leaves mid-game goes to the first in line at once, keeping the seat's game. The rest are seated at the next game, bots making room if the table is full. */
function takeLeftSeats(room) {
  if (!true || !room.waiting || !room.waiting.length || room.status === "lobby" || room.status === "over") return false;
  let seated = false;
  for (let seat = 0; seat < room.players.length && room.waiting.length; seat++) {
    const old = room.players[seat];
    if (!old.left) continue;
    const w = room.waiting.shift();
    // The seat keeps its game (its place, its cards, its score); only who sits in it changes.
    room.players[seat] = Object.assign({}, old, { id: w.id, name: w.name, avatar: w.avatar, bot: false, botControlled: false,
      left: false, connected: true, plus: w.plus, acct: w.acct, look: w.look, timeouts: 0 });
    room.log = `${w.name} took ${old.name}'s seat.`;
    seated = true;
  }
  return seated;
}
function seatTheLine(room) {
  while (room.waiting && room.waiting.length) {
    if (room.players.length >= MAX_PLAYERS) {
      const bot = room.players.findIndex((p) => p.bot);
      if (bot < 0) break;
      room.players.splice(bot, 1);
    }
    const w = room.waiting.shift();
    const seat = { id: w.id, name: w.name, avatar: w.avatar, bot: false, left: false, connected: true, plus: w.plus, acct: w.acct, look: w.look };
    seat.plus = w.plus;
    room.players.push(seat);
  }
}
function lineState(room, st, playerId, seat) {
  st.waiting = (room.waiting || []).map((w) => ({ name: w.name, avatar: w.avatar }));
  st.waitPos = seat < 0 ? (room.waiting || []).findIndex((w) => w.id === playerId) + 1 : 0;
  return st;
}

  /* The whole state for one player. The bots' level is its last field, and only when it is not the usual one: a room
     at normal sends exactly what it always sent. */
  function fullState(room, seat, playerId) {
    const st = lineState(room, stateFor(room, seat), playerId, seat);
    if (Bots.level(room.botLevel) !== "normal") st.botLevel = room.botLevel;
    return st;
  }
  function sendState(code) {
    const room = rooms.get(code);
    const socks = roomSockets.get(code);
    if (!room || !socks) return;
    for (const s of socks) {
      const seat = room.players.findIndex((p) => p.id === s.data.playerId);
      s.emit("state", { room: fullState(room, seat, s.data.playerId), mySeat: seat, v: room.v });
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
    if (r.status === "playing") armTimer(code);   // GN-10: the deadline is set before the state that shows it
    bump(r);
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
  /* How long a bot takes (pacing round 1, 2026-11-01). The owner's phone log: every bot turn took 1.9 s however little there
     was to decide, and the three bots of a four-seat game kept a person waiting 5.9 s. A bot's turn is one state (it draws and
     discards inside it; the app lays the draw before the throw), so what it takes is its thought and the card's travel: 0.8-1.15 s
     as a rule, 0.7-1.0 s far from a hand (a snap), a beat more for the face-up card it takes (0.1-0.25 s) and for a hand close to
     going out (0.25-0.6 s), never over BOT_MAX_MS. The next bot's wait starts when the last one's state is sent, so it runs
     while the last discard flies. BOT_STALL_MS after its time, a bot that has not acted is made to (botWatch). BOT_MS scales
     it all (the tests' BOT_MS=5 stay instant). */
  const BOT_MAX_MS = 2200, BOT_STALL_MS = Math.max(100, Number(process.env.BOT_STALL_MS || 3000));
  const botWatches = new Map();
  const botStats = { actions: 0, watchdog: 0, failed: 0 };
  function botThinkMs(room) {
    const k = BOT_MS / 1200;
    let ms = 800 + Math.random() * 350;
    try {
      const seat = room.turn, hand = room.hands[seat];
      if (room.phase === "draw" && hand) {
        const dw = deadwood(hand, room.wildRank);
        if (dw > 30) ms = 700 + Math.random() * 300;
        else if (dw <= 10) ms += 250 + Math.random() * 350;
        const top = room.open && room.open[room.open.length - 1];
        if (top && botWantsOpen(hand, top, room.wildRank)) ms += 100 + Math.random() * 150;
      }
    } catch (e) { /* the middle of the range */ }
    return Math.max(BOT_MS < 100 ? BOT_MS * 2 : 1, Math.round(Math.min(BOT_MAX_MS, ms) * k));
  }
  const whereOf = (r) => `${r.round || 0}|${r.turn}|${r.phase}|${r.open ? r.open.length : 0}|${r.closed ? r.closed.length : 0}`;
  function clearBotWatch(code) { const w = botWatches.get(code); if (w) { clearTimeout(w); botWatches.delete(code); } }
  function scheduleBot(code) {
    clearT(botTimers, code);
    clearBotWatch(code);
    const room = rooms.get(code);
    if (!room) return;
    const tok = room.botTok = (room.botTok || 0) + 1;   // a queued bot turn from an older schedule is dropped
    if (room.status !== "playing") return;
    const p = room.players[room.turn];
    if (!p || !(p.bot || p.botControlled)) return;
    const delay = botThinkMs(room), at0 = whereOf(room);
    botTimers.set(code, setTimeout(() => { botTimers.delete(code); queueBot(code, tok); }, delay));
    // The watchdog: a bot whose turn has not moved BOT_STALL_MS after its time (a lost timer, a queue that never ran) is made to act.
    botWatches.set(code, setTimeout(() => {
      botWatches.delete(code);
      const r = rooms.get(code);
      if (!r || r.status !== "playing" || r.botTok !== tok || whereOf(r) !== at0) return;
      const cur = r.players[r.turn];
      if (!cur || !(cur.bot || cur.botControlled)) return;
      botStats.watchdog++;
      console.warn(`[${new Date().toISOString()}] rummy bot ${code}: no action ${delay + BOT_STALL_MS} ms after its turn began; the watchdog plays it`);
      playBot(r, code);
    }, delay + BOT_STALL_MS));
  }
  /* One bot turn, whatever goes wrong in it: the cards are played the plainest way (draw closed, throw the dearest card) rather
     than the table waiting out the turn clock; and the exception does not reach the event loop (it would stop every room). */
  function playBot(r, code) {
    try {
      botAct(r);
      botStats.actions++;
    } catch (e) {
      botStats.failed++;
      console.error(`[${new Date().toISOString()}] rummy bot turn failed in ${code}:`, (e && e.stack) || e);
      try {
        if (r.status === "playing" && r.phase === "draw") doDraw(r, r.turn, "closed") || doDraw(r, r.turn, "open");
        if (r.status === "playing" && r.phase === "discard") {
          const hand = r.hands[r.turn];
          const dear = hand.filter((c) => c.id !== r.pickedOpenId).sort((a, b) => cardPoints(b, r.wildRank) - cardPoints(a, r.wildRank))[0] || hand[0];
          doDiscard(r, r.turn, dear.id);
        }
      } catch (e2) { console.error("rummy bot fallback failed:", (e2 && e2.stack) || e2); }
    }
    if (r.status === "playing") armTimer(code);   // GN-10
    bump(r);
  }
  /* A bot's turn is real work (the deadwood search, a few milliseconds). Bot timers that fall due together used to
     run back to back in one timers phase, and a human's move waited behind all of them: with 200 rooms of bots the
     p99 of a move went from 12 to 85 ms. Now a due bot only joins a queue, and the queue runs a few milliseconds of
     bot turns per turn of the event loop (setImmediate), so sockets are heard between slices. */
  const BOT_SLICE_MS = 4;
  const botQueue = [];
  let botDraining = false;
  function queueBot(code, tok) {
    botQueue.push({ code, tok });
    if (!botDraining) { botDraining = true; setImmediate(drainBots); }
  }
  function drainBots() {
    const t0 = performance.now();
    while (botQueue.length && performance.now() - t0 < BOT_SLICE_MS) {
      const { code, tok } = botQueue.shift();
      const r = rooms.get(code);
      if (!r || r.botTok !== tok || r.status !== "playing") continue;
      const cur = r.players[r.turn];
      if (!cur || !(cur.bot || cur.botControlled)) continue;
      playBot(r, code);
    }
    if (botQueue.length) setImmediate(drainBots); else botDraining = false;
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
  /* The bots' levels (2026-11-13, bots.js). A bot's seat plays at the room's level. A person's seat the bot plays for
     (a turn that timed out, a seat left to the bot) always plays the normal game, and so does every quick-play room.
     Normal is botAct's own body, as it has always been, move for move. */
  function botLevelOf(room, seat) {
    const p = room.players[seat];
    return p && p.bot && !room.quick ? Bots.level(room.botLevel) : "normal";
  }
  /* The table as the seat whose turn it is may know it: its own hand, what lies face up, what was thrown and taken. */
  function botTable(room, seat) {
    const p = room.players[seat], act = activeSeats(room);
    let next = seat;
    if (act.length > 1) do { next = (next + 1) % room.players.length; } while (!act.includes(next));
    return {
      seat, hand: room.hands[seat], wildRank: room.wildRank, wildCard: room.wildCard,
      top: room.open[room.open.length - 1], open: room.open, pickedOpenId: room.pickedOpenId, mem: room.mem, next,
      firstTurn: !(room.drew && room.drew[seat]), pool: !!room.pool,
      poolLeft: room.pool ? room.pool - ((room.totalsById && room.totalsById[p.id]) || 0) : null,
      active: act.length, rnd: Math.random,
    };
  }
  /* An easy or a sharp bot's turn. bots.js only says what it would do; every move is the server's own draw, drop,
     declare and discard, and one of those turning a move away falls back to the normal bot's move. */
  function botActAt(room, seat, lv) {
    const t = botTable(room, seat);
    if (room.phase === "draw") {
      let from = Bots.draw(lv, t);
      if (from === "drop") { if (doDrop(room, seat)) return; from = "closed"; }
      if (from !== "open") from = "closed";
      if (!doDraw(room, seat, from)) { if (!doDraw(room, seat, from === "open" ? "closed" : "open")) { nextTurn(room); return; } }
      t.hand = room.hands[seat]; t.top = room.open[room.open.length - 1]; t.open = room.open; t.pickedOpenId = room.pickedOpenId; t.firstTurn = false;
    }
    const hand = room.hands[seat];
    const p = Bots.play(lv, t);
    if (p && p.declare) {
      const kept = hand.filter((c) => c.id !== p.declare.id);
      if (p.declare.id !== room.pickedOpenId && kept.length === 13 && validateDeclare(kept, p.declare.groups, room.wildRank).valid &&
        doDeclare(room, seat, p.declare.id, p.declare.groups)) return;
    } else if (p && doDiscard(room, seat, p.discard)) return;
    doDiscard(room, seat, botDiscardCard(hand, room.wildRank, room.pickedOpenId).id);
  }
  function botAct(room) {
    const seat = room.turn;
    { const lv = botLevelOf(room, seat); if (lv !== "normal") return botActAt(room, seat, lv); }
    if (room.phase === "draw") {
      const top = room.open[room.open.length - 1];
      const from = botWantsOpen(room.hands[seat], top, room.wildRank) ? "open" : "closed";
      if (!doDraw(room, seat, from)) { if (!doDraw(room, seat, from === "open" ? "closed" : "open")) { nextTurn(room); return; } }
    }
    const hand = room.hands[seat];
    const win = botFinishCard(hand, room.wildRank, room.pickedOpenId);
    if (win) { doDeclare(room, seat, win.id, win.groups); return; }
    doDiscard(room, seat, botDiscardCard(hand, room.wildRank, room.pickedOpenId).id);
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

  /* Ratings and the bots' levels: a game with bots that play easy or sharp is not rated (easy bots would hand out
     rating, sharp ones would take it from the people at the table). A table of people only, and every game with the
     normal bots, counts as ever. */
  Quick.init({ game: 'rummy', model: 'openskill', seats: 4, codeKey: 'code', app, io, rooms, base: BASE, broadcast: sendState,
    rated: (r) => Bots.level(r.botLevel) === "normal" || !r.players.some((p) => p.bot && !p.left) });
  io.on("connection", (socket) => {
    Plus.guardSocket(socket);   // the wallet's signed entitlement: every event's `plus` is the checked answer (the Nest Wallet repo, contrib/ROLLOUT.md)
    Quick.hook(socket); Quick.connection(socket);   // before the server's own events
    const on = guarded(socket);   // every client event below goes through the guard
    socket.data.playerId = null;
    socket.data.code = null;
    const currentRoom = () => rooms.get(socket.data.code);
    Reactions.wire({ on, room: currentRoom, me: () => socket.data.playerId, isHost: (r) => r.host === socket.data.playerId, bump });
    /* GN-20: a socket sits in one room at a time. Seating it in another first takes it out of the one it was in, as
       a disconnect would, so it never hears two rooms' states. socket.data.as is the player it sits as. */
    const attach = (code) => {
      if (socket.data.code && socket.data.code !== code) awayFromRoom();
      socket.data.code = code; socket.data.as = socket.data.playerId;
      if (!roomSockets.has(code)) roomSockets.set(code, new Set());
      roomSockets.get(code).add(socket);
    };
    const detach = () => {
      const set = roomSockets.get(socket.data.code);
      if (set) set.delete(socket);
      socket.data.code = null;
    };
    const mySeat = (room) => room.players.findIndex((p) => p.id === socket.data.playerId);
    /* This socket stops being in its room (it disconnected, or it sat down in another room). Its player shows away,
       with the AFK clock if it is their turn, unless another socket of theirs is still in the room (a rejoin that
       beat the old socket's timeout). */
    function awayFromRoom() {
      const room = currentRoom();
      const as = socket.data.as || socket.data.playerId;
      detach();
      if (!room || !rooms.has(room.code)) return;
      const p = room.players.find((q) => q.id === as);
      // A watcher in the waiting line who goes away leaves the line (they can join again).
      if (!p && room.waiting && room.waiting.some((w) => w.id === as)) { room.waiting = room.waiting.filter((w) => w.id !== as); bump(room); return; }
      const still = p && [...(roomSockets.get(room.code) || [])].some((s) => (s.data.as || s.data.playerId) === as);
      if (p && !still) { p.connected = false; if (room.voice) room.voice.delete(room.players.indexOf(p)); ensureHost(room); }
      if (p && !still && room.status === "playing" && room.players[room.turn] === p) armTimer(room.code);   // 5 s clock while they are away (GN-10: before the state)
      room.v++;
      sendState(room.code);
    }

    on("create", ({ name, playerId, avatar, plus, look, crew } = {}) => {
      name = capName(name); if (!name) return refuse(socket, "name_required", "Pick a name first.", "create"); name = Moderation.name(name);
      const code = Plus.crewCode({ plus, crew }, rooms, newCode);   // GameNest Plus's crew code (2026-10-17)
      const room = { code, status: "lobby", host: playerId, players: [], chat: [], log: "", v: 1,
        touched: Date.now(), voice: new Set(), phase: "lobby" };
      room.players.push({ id: playerId, name, avatar: capAvatar(avatar) || "\u{1F0CF}", bot: false, left: false, connected: true });
      rooms.set(code, room);
      socket.data.playerId = playerId;
      attach(code);
      stampPlus(code, socket, { plus, look }); socket.emit("joined", { code });
      bump(room);
    });

    on("join", ({ code, name, playerId, avatar, plus, look, caps } = {}) => {
      code = clean(code, 6).toUpperCase();
      const room = rooms.get(code);
      if (!room) return refuse(socket, "not_found", "No room with that code.", "join");
      socket.data.playerId = playerId;
      const existing = room.players.find((p) => p.id === playerId);
      if (existing) {
        existing.connected = true; existing.left = false; humanIsBack(room, existing, "reconnected"); attach(code); stampPlus(code, socket, { plus, look }); socket.emit("joined", { code });
        if (room.status === "playing" && room.players[room.turn] === existing) armTimer(code);   // GN-10: the deadline before the state
        bump(room);
        return;
      }
      if (room.status === "lobby" && room.players.length >= MAX_PLAYERS) return refuse(socket, "full", "Room is full (6).", "join");
      name = capName(name); if (!name) return refuse(socket, "name_required", "Pick a name first.", "join"); name = Moderation.name(name);
      // A game under way: an app that knows the line waits in it; an older one hears the game has started.
      if (room.status !== "lobby") {
        if (!(Array.isArray(caps) && caps.includes("waitList"))) return refuse(socket, "started", "That game already started.", "join");
        room.waiting = room.waiting || [];
        if (!room.waiting.some((q) => q.id === playerId)) {
          if (room.waiting.length >= MAX_PLAYERS) return refuse(socket, "full", "Room is full (6).", "join");
          room.waiting.push({ id: playerId, name, avatar: capAvatar(avatar) || "\u{1F0CF}", plus: plus === true, acct: Plus.acctOf(socket), look: Plus.cleanLook(look), caps });
          room.log = `${name} is waiting for a seat.`;
        }
        attach(code);
        socket.emit("joined", { code, waiting: true });
        takeLeftSeats(room);
        bump(room);
        return;
      }
      room.players.push({ id: playerId, name, avatar: capAvatar(avatar) || "\u{1F0CF}", bot: false, left: false, connected: true });
      attach(code);
      stampPlus(code, socket, { plus, look }); socket.emit("joined", { code });
      room.log = `${name} joined.`;
      bump(room);
    });

    on("addBot", () => {
      const room = currentRoom();
      if (!room || room.status !== "lobby" || room.host !== socket.data.playerId) return;
      const b = addBotTo(room);
      if (b) { room.log = `${b.name} (bot) joined.`; bump(room); }
    });
    on("removeBot", () => {
      const room = currentRoom();
      if (!room || room.status !== "lobby" || room.host !== socket.data.playerId) return;
      for (let i = room.players.length - 1; i >= 0; i--) if (room.players[i].bot) { room.players.splice(i, 1); break; }
      bump(room);
    });

    /* The host's pick of the table's look in a Plus room's lobby (the tea-estate pavilion, the Diwali rooftop or the desert camp): plus.js decides who may; every app redraws it from the state. */
    on("look", ({ slot, id } = {}) => {
      const room = currentRoom();
      if (room && Plus.pickLook(room, socket.data.playerId, slot, id)) bump(room);
    });
    on("settings", ({ pool, botLevel } = {}) => {   // T15: pool game (101 / 201) or single deals (0), host in the lobby
      const room = currentRoom();
      if (!room || room.status !== "lobby" || room.host !== socket.data.playerId) return;
      /* The bots' level (2026-11-13): easy | normal | sharp, the host's pick in the lobby, normal until it is picked.
         A quick-play room keeps the normal bots. A `settings` without `botLevel` is the message it always was. */
      if (botLevel !== undefined) {
        if (!Bots.LEVELS.includes(botLevel)) refuse(socket, "bot_level", "No such bot level.", "settings");
        else if (room.quick && botLevel !== "normal") refuse(socket, "bot_level", "Quick play uses the normal bots.", "settings");
        else if (Bots.level(room.botLevel) !== botLevel) {
          room.botLevel = botLevel;
          room.log = botLevel === "easy" ? "The bots will take it easy." : botLevel === "sharp" ? "The bots will play sharp." : "The bots will play their usual game.";
          if (![0, 101, 201].includes(pool)) bump(room);
        }
      }
      if (![0, 101, 201].includes(pool)) return;
      room.pool = pool; room.totalsById = {}; room.champion = null;
      room.log = pool ? `Pool game to ${pool}: cross it and you're out; last one standing wins.` : "Single deals — every game stands alone.";
      bump(room);
    });
    on("start", () => {
      const room = currentRoom();
      if (!room || room.status !== "lobby" || room.host !== socket.data.playerId) return;
      if (room.players.filter((p) => !p.left).length < 2) return refuse(socket, "not_enough_players", "Need at least 2 players — add a bot.", "start");
      setupGame(room);
      bump(room);
    });

    on("draw", ({ from } = {}) => {
      const room = currentRoom();
      if (!room || room.status !== "playing") return;
      { const self = room.players[mySeat(room)]; if (self && humanIsBack(room, self, "took the seat back")) bump(room); }   // any action reclaims a bot-controlled seat
      if (room.phase !== "draw") return;
      const seat = mySeat(room);
      if (seat !== room.turn) return;
      if (from !== "open" && from !== "closed") return;
      if (doDraw(room, seat, from)) { armTimer(room.code); bump(room); }   // GN-10
      else if (from === "open" && room.open.length && isJoker(room.open[room.open.length - 1], room.wildRank)) refuse(socket, "joker_from_open", "You can't pick up a joker from the open pile.", "draw");
      else refuse(socket, "pile_empty", "That pile is empty.", "draw");
    });

    on("drop", () => {   // T7
      const room = currentRoom();
      if (!room || room.status !== "playing") return;
      { const self = room.players[mySeat(room)]; if (self && humanIsBack(room, self, "took the seat back")) bump(room); }
      const seat = mySeat(room);
      if (seat !== room.turn || room.phase !== "draw") return refuse(socket, "not_your_drop", "You can only drop on your turn, before drawing.", "drop");
      if (doDrop(room, seat)) { if (room.status === "playing") armTimer(room.code); bump(room); }   // GN-10
    });
    if (process.env.TEST_HOOKS === "1") {   // test-only: lose a bot's timer (the watchdog must play it), read what the bots have done
      on("__loseBotTimer", () => { const room = currentRoom(); if (!room) return; const t = botTimers.get(room.code); if (t) { clearT(botTimers, room.code); } socket.emit("botStats", Object.assign({ lost: !!t }, botStats)); });
      on("__botStats", () => socket.emit("botStats", botStats));
    }
    if (process.env.TEST_HOOKS === "1") on("__test", ({ openTop, hands } = {}) => {   // test-only: craft the open pile / hands
      const room = currentRoom(); if (!room || room.status !== "playing") return;
      if (openTop && typeof openTop === "object") room.open.push({ id: 900000 + crypto.randomInt(99999), s: String(openTop.s), r: Number(openTop.r) || 0 });
      if (hands && typeof hands === "object") for (const [seat, cards] of Object.entries(hands)) if (room.hands[Number(seat)] && Array.isArray(cards)) { room.hands[Number(seat)] = cards.map((c) => ({ id: 900000 + crypto.randomInt(99999), s: String(c.s), r: Number(c.r) || 0 })); room.groups[Number(seat)] = []; }
      bump(room);
    });

    on("discard", ({ id } = {}) => {
      const room = currentRoom();
      if (!room || room.status !== "playing") return;
      { const self = room.players[mySeat(room)]; if (self && humanIsBack(room, self, "took the seat back")) bump(room); }   // any action reclaims a bot-controlled seat
      if (room.phase !== "discard") return;
      const seat = mySeat(room);
      if (seat !== room.turn) return;
      if (!Number.isInteger(id)) return;
      if (room.pickedOpenId === id) return refuse(socket, "picked_card", "You can't discard the card you just picked up.", "discard");
      if (doDiscard(room, seat, id)) { armTimer(room.code); bump(room); }   // GN-10
    });

    on("arrange", ({ groups } = {}) => {
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
      socket.emit("state", { room: fullState(room, seat, socket.data.playerId), mySeat: seat, v: room.v });
    });

    on("declare", ({ discardId, groups } = {}) => {
      const room = currentRoom();
      if (!room || room.status !== "playing") return;
      { const self = room.players[mySeat(room)]; if (self && humanIsBack(room, self, "took the seat back")) bump(room); }   // any action reclaims a bot-controlled seat
      if (room.phase !== "discard") return;
      const seat = mySeat(room);
      if (seat !== room.turn) return;
      if (!Number.isInteger(discardId)) return;
      if (doDeclare(room, seat, discardId, Array.isArray(groups) ? groups : room.groups[seat])) {
        if (room.status === "playing") armTimer(room.code);   // GN-10
        bump(room);
      }
    });
    on("takeSeat", () => {
      const room = currentRoom(); if (!room) return;
      const self = room.players[mySeat(room)];
      if (self && humanIsBack(room, self, "took the seat back")) bump(room);
    });
    on("pushToken", ({ token } = {}) => { const room = currentRoom(); if (!room) return; const p = room.players.find((q) => q.id === socket.data.playerId); if (p && typeof token === "string" && /^[0-9a-f]{32,200}$/i.test(token)) p.pushToken = token; });
    on("presence", ({ away } = {}) => { const room = currentRoom(); if (!room) return; const p = room.players.find((q) => q.id === socket.data.playerId); if (p) p.away = !!away; });


    on("chat", ({ t } = {}) => {
      const room = currentRoom();
      if (!room) return;
      const seat = mySeat(room);
      const me = room.players[seat];
      if (!me || me.left) return;
      const now = Date.now();
      if (me._lastChat && now - me._lastChat < 700) return;
      me._lastChat = now;
      t = clean(t, 140); if (!t) return;
      const code = room.code, pid = me.id;
      Moderation.chat(t).then((shown) => {
        const room = rooms.get(code), me = room && room.players.find((q) => q.id === pid);   // gone while it was read
        if (!me || me.left) return;
        room.chat.push({ n: me.name, a: me.avatar, t: shown }); for (const q of room.players) if (q !== me) pushTo(q, me.name + ": " + shown, { code: room.code, game: PUSH_TITLE }, room.code + "-chat");
        if (room.chat.length > 200) room.chat.splice(0, room.chat.length - 200);
        bump(room);
      });
    });

    on("voice", ({ kind, to, data } = {}) => {
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

    on("rematch", () => {
      const room = currentRoom();
      if (!room || room.status !== "over" || room.host !== socket.data.playerId) return;
      room.players = room.players.filter((p) => !p.left);
      seatTheLine(room);
      if (room.players.filter((p) => !p.bot).length === 0) { deleteRoom(room.code); return; }
      if (room.champion != null || room.players.filter((p) => !p.pooledOut).length < 2) {   // T15: the pool is settled → fresh match
        room.totalsById = {}; room.champion = null; room.players.forEach((p) => { p.pooledOut = false; });
      }
      if (room.players.length < 2) { room.status = "lobby"; room.phase = "lobby"; room.log = "Back to the lobby."; bump(room); return; }
      setupGame(room);
      bump(room);
    });

    function handleLeave() {
      const room = currentRoom();
      if (!room) return detach();
      const p = room.players.find((q) => q.id === (socket.data.as || socket.data.playerId));
      if (!p) {
        // Out of the waiting line.
        const before = (room.waiting || []).length;
        room.waiting = (room.waiting || []).filter((w) => w.id !== socket.data.playerId);
        detach();
        if (room.waiting.length !== before) bump(room);
        return;
      }
      if (room.voice) room.voice.delete(room.players.indexOf(p));
      if (room.status === "lobby") {
        room.players = room.players.filter((q) => q.id !== p.id);
        if (room.players.length === 0 || room.players.every((q) => q.bot)) { detach(); deleteRoom(room.code); return; }
        if (room.host === p.id) room.host = (room.players.find((q) => !q.bot) || room.players[0]).id;
        room.log = `${p.name} left.`;
      } else {
        const seat = room.players.indexOf(p);
        p.left = true; p.connected = false;
        // The first in line takes the seat before anything is decided for want of players.
        const taken = takeLeftSeats(room);
        if (room.players.every((q) => q.bot || q.left)) { detach(); deleteRoom(room.code); return; }
        if (room.host === p.id) room.host = (room.players.find((q) => !q.bot && !q.left) || room.players[0]).id;
        if (!taken) room.log = `${p.name} left the game.`;
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
    on("leave", () => handleLeave());
    socket.on("disconnect", () => { if (currentRoom()) awayFromRoom(); });
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
  deadwood, botDiscardCard, botFinishCard, botWantsOpen,
  capName, capAvatar, FEATURES, Bots,
};

if (require.main === module) startServer();
