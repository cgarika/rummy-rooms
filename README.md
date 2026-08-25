# rummy-rooms — needasix.com/rummy

Indian 13-card rummy, 2-6 players. Two decks + two printed jokers + a wildcard
rank drawn each game. Server-side meld validation is the engine: a declare
needs >= 2 sequences, at least one PURE (no jokers), rest valid sets/sequences.
Losers score their deadwood (A/faces 10, jokers 0), capped 80; a wrong declare
is an instant 80. Optional bots (draw/discard heuristic, only ever declare a
provably valid hand via the built-in arrangement solver).

House standard: rooms/rejoin/host/rematch/chat/WebRTC voice/2h cleanup,
BASE_PATH subpath pattern, per-player stateFor() hand secrecy.

## Run
    npm install
    BASE_PATH=/rummy PORT=3000 node server.js

## Rules suite (run BEFORE trusting any change)
    BOT_MS=5 PORT=3411 node server.js &
    node test/rules.js

Proves: meld/declare validator table, points math, solver cross-check,
deal integrity, hand secrecy, open-pile discard block, arrange persistence,
wrong-declare penalty, valid declare with correct scoring, reshuffle, rematch,
bot game completion.

## Env
- TURN_MS (default 45000) — turn timer; timeout auto-draws/discards
- BOT_MS (default 1200) — bot think time
