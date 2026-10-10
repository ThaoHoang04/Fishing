# MVP release checklist

Run through this before putting a build in front of other people. "Auto" items are enforced by `npm test`.

## Build and deploy
- [ ] `npm install` then `npm test` - all green (server rules, economy on both stores, fishing/reeling, assets/licenses, production server, soak).
- [ ] `npm start` (= `vite build` + `node server/index.js`). The server serves the built game itself on `PORT` (default 3001).
- [ ] `GET /health` answers `{"ok":true,...}` (use it as the uptime check).
- [ ] Set `FT_DB` to a path on a **persistent disk** (default `data/fishing.sqlite`). Back this file up: it holds every player's coins, bag and gear.
- [ ] Behind a proxy/CDN: allow WebSocket upgrades for `/socket.io`.
- Auto: the production build serves gzip, fingerprinted JS cached for a year, `index.html` never cached, first load under ~0.7 MB over <= 25 requests (`tests/production.test.mjs`).

## Licenses and credits
- [ ] `credits/ASSET_LICENSES.md` has a row for every pack, with the date the terms were checked.
- [ ] `credits/terms/` holds the saved store page for every pack that ships.
- [ ] Re-open each shipped pack's page and confirm the terms did not change since 2026-10-04 (A1, A2, A6).
- [ ] A1 asks for credit and forbids NFT / AI-training use: this game does neither. The credit is in the lobby ("Credits").
- Auto: every file in `public/assets/` is in `credits/asset_manifest.json` with a pack that is marked "used"; packs marked "not used" ship nothing; every pack that requires credit is in `src/data/credits.json`; nothing ships that is never loaded (`tests/assets.test.mjs`).
- Not shipped on purpose: A3 (wrong art style), A4 and A7 (no license text, ask the authors), A5, A8 (evaluated, not needed).

## Gameplay QA (two players)
- Auto: a 90-round accelerated session per bot - fishing, losing fights, selling, buying, emotes, mid-game disconnects and rejoins - ends with coins that add up to the coin, bags within capacity, every landed fish on record, scoreboard matching reality, and every server table back to zero (`tests/soak.test.mjs`).
- Auto: joins/drops/rejoins never exceed 2 players per room and never leave a room behind.
- [ ] 20-30 minutes with two real people on two machines over the real network (the automated runs are on localhost).
- [ ] Reload a tab mid-fight and mid-wait: you come back idle, coins and bag intact.
- [ ] Pull the network cable for ~10 s: the red "reconnecting" banner shows, the game comes back by itself.
- [ ] Open the game in two tabs of one browser: each tab is its own player with its own bag.

## Expansion (Open Ocean) - check by hand
- [ ] Both players sail out, fish a zone, return: each sees the other only while on the same map.
- [ ] Look at the sky for a full day cycle (6 min): dusk tint, night, rain and storm effects, the event banner at the start of an event.
- [ ] Reload a tab while at sea: it comes back at sea. Pull the network while sailing: the red banner appears and it recovers.
- [ ] Shared boat: one boards the other (B), driver sails (the passenger rides), passenger fishes (the boat holds still), swap with V, step off with B, and sail home together.
- [ ] Fighting: both press F (name shows [FIGHT]), J/K/L hit, the victim is knocked back and dizzy, cannot move for a moment, and the line they had out is gone. One in Friendly mode: nothing happens.
- [ ] Falling in: push your friend at the shore/pier edge (both in FIGHT mode): they splash in, swim, and either climb out alone or are rescued with R then G.
- [ ] Stealing: both in FIGHT mode; Ann lands a fish, Ben stands next to her and presses T within 3 s; both press SPACE; the fish moves (or stays), the loser stumbles. Friendly mode on either side: refused.
- [ ] Random events: keep fishing for ~10 minutes: junk (and the LEGENDARY?! tease), a seagull (shoo it), a chest (both press O), the glowing lucky spot in the top right.
- [ ] Co-op boss: wait for BOSS FISH SPOTTED! (or restart the server and wait ~90 s), both cast at the red ring, hook, fight with swapped jobs, win/lose; check nothing is stuck afterwards (casting works again).
- [ ] Social: earn a title (e.g. push your friend 8 times), wear it from I > Memories, see it on the name tags; wait for a contest (5-9 min) and check the countdown, scores and result; take a photo with P after a title/boss and save it; restart the server and check the memory board is still there.
- [ ] Music: it starts after the first key press, changes at night (a slower tune) and in the boss fight, and M silences it. Check the volume against the effects on your speakers/headphones.
- [ ] Boat tipping: both ride one boat, driver and passenger hold the same sideways key about 2 s: it flips, both are dunked and then back.
- [ ] Anger/throw/duel: both in FIGHT mode, hit each other until ANGRY shows, press H; catch some junk, press Z; press U, answer Y, fight a duel to a KO (punch/kick/dodge), check the winner's prize and that nothing else changed.
- Auto: map/collision rules, boat speed and island blocking on the server, per-map relays (movement, emotes, fishing lines), portal checks, world clock/weather/events determinism, boss difficulty (`tests/maps.test.mjs`, `tests/travel.test.mjs`, `tests/world.test.mjs`).

## Known limits (not blockers for a friends-only MVP)
- No rate limit on creating rooms/profiles; fine for friends, add one before a public launch.
- The server holds rooms in memory: a server restart ends running games (profiles, coins, bags and the FishDex are saved).
- Sound and music are synthesised, short and simple (a few looping bars per theme).
- The offline Local test is lake-only (no boat/ocean); aquarium, tournaments and extra maps beyond the ocean are not built.
- Two boats side by side at sea may overlap (no boat-to-boat collision).
- A stolen fish counts in the thief's FishDex like a catch (the owner keeps theirs). The duel is judged on the server's clock, so a very slow connection is at a small disadvantage.
- The co-op boss fight is simulated on the server and streamed at 20 Hz: on a slow connection the bars lag a little (the fight is tuned for a good pair to win about 8 in 10 on a standard rod). Only one boss species (Ancient Catfish); Great White Shark and Dragon Koi are not built, and the boss reward has no title or boat skin.
- Not built: "Fastest Catch" contests, the boat skin and photo-pose unlocks (levels list them, nothing uses them yet), a boss title/skin reward. The photo is the plain game screen (HUD included) in a frame; the friendship points are per profile, so two friends who have played with other people have different totals.
- Not built from the brief's event list: "old phone" and "tire" junk (other items stand in), weather that makes the boat harder to steer, boss spotted alerts. The random-event rates are in `src/data/randomEvents.json`.
- "Challenge for a fish" duels (the brief's Fish Duel) are not built. Only a push (or a big push) drops someone in the water (a slap or bonk stops at the shore), and only on the lake (no swimming at sea).
- The boss has no extra gear tier above the Titanium line: it is hard but fair with the best rod + line.
