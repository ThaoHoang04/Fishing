# Fishing Together

A cozy 2D pixel-art top-down **co-op fishing game for two players**, played in the browser. Fish side by side on a sunset lake,
sail to an open ocean and a frozen bay, beat bosses and giant fish together... or cause a little friendly chaos (push your friend
off the pier, steal their catch, challenge them to a duel in the arena). Works on a computer and on a phone (touch controls).

Built with **Phaser 4**, **Node + Express + Socket.IO** and **SQLite** (sql.js). The server is authoritative: positions, casts,
reeling fights, steals, bosses and duels are all validated or simulated on the server.

## Highlights

- Two-player rooms with a 4-letter code (LAN or any public tunnel), reconnect within 30 s, saved profiles (coins, bag, gear, hats, friendship)
- Timing-based casting and a deterministic reeling mini-game, 4 fish behaviours, 3 maps (lake, open ocean, frozen bay), weather, day/night
- Market, gear (rods, lines, baits), FishDex, hats, memory board, titles and friendship levels
- Together: shared boat (it can tip and capsize), co-op bosses and giant fish, Rare Splash races, mini contests, chests, seagulls, photo mode
- Mischief (opt-in with FIGHT mode): slap / push / bonk, an anger meter with a big push, thrown fish, swimming and rescues, fish stealing, solo **duels in a boxing arena**
- Touch controls (stick + moba-style skill cluster) and a skill bar for PC; chat with quick phrases; synthesised sound and music (no audio files)

## Quick start

Requires Node.js 20+.

```
npm install
npm run dev      # Vite (http://localhost:5173) + game server (:3001), both with reload
npm test         # all tests (node:test)
npm start        # production: builds the client and serves it from the game server (PORT, FT_DB)
```

**Art is not in this repository.** The free asset packs the game uses do not allow their source files to be redistributed, so
`public/assets/` is git-ignored. Fetch and prepare it once (details and licences in `credits/ASSET_LICENSES.md`):

```
python tools/fetch_assets.py      # downloads the free packs into vendor/ (also git-ignored)
# extract each archive into vendor/<ID>/x/ , then:
python tools/normalize_assets.py  # writes public/assets/ and credits/asset_manifest.json
```

Two players: open the game in two tabs (or on two devices), **Create room** in one, **Join** with the code in the other, both press **Ready**.
Over a LAN open `http://<your-ip>:3001`; for friends elsewhere, run any tunnel to port 3001 (for example `cloudflared tunnel --url http://localhost:3001`).

## Controls

| | Keys |
|---|---|
| Move / sail | WASD |
| Fish | SPACE (hold to charge, release to cast; reel with SPACE) |
| Market / bag | E at the stall / I anywhere |
| Boat | B at a portal, or next to your friend's boat; V swaps seats |
| Chat / emotes | ENTER / 1-4 |
| Fight mode | F, then J slap, K push, L bonk, H big push, Z throw, R rescue, G grab, T steal, U duel |
| Help list in game | / |

On a phone the controls appear on screen automatically (add `?touch=1` to try them on a computer).

## Feature guide

Everything below is a short note on one feature; the data lives in `src/data/*.json`.

- Two players: open the game in two tabs, **Create room** in one, **Join** with the 4-letter code in the other, both press **Ready**.
- Solo testing without a server: **Local test** button (P1 = WASD, P2 = arrows, TAB switches camera).
- **Fishing:** stand on a glowing spot, hold **SPACE** (or E) to charge the power bar, release to cast. When the `!` appears, press SPACE inside the 1-1.5 s window (too early scares the fish). Then **reel**: hold SPACE to pull the fish in (tension rises), release when the fish pulls or the bar gets high (tension drops, the fish takes line). Land it before the line snaps (tension 100) or the fish escapes (distance 100). **X** lets go; ESC lets go first and only then leaves the room. In local test, P2 uses ENTER (let go: Backspace).
- Fish behaviour lives in `src/data/behaviours.json` (Normal / Fast / Strong / Trickster) and `src/data/fish.json` (species -> behaviour + difficulty). The fight is a deterministic simulation (`src/systems/ReelSim.js`); the server replays the recorded input to confirm every catch.
- **Market:** walk to the red-and-white stall and press **E** to sell fish (select rows, or Sell all) and buy rods, lines and baits; **I** opens your bag and gear anywhere (switch gear you own, no trading away from the stall). The bag holds 20 fish: when it is full you cannot cast. Gear is locked while a line is out.
- ESC leaves the room. Reloading the tab mid-game puts you back in your slot (30 s grace).
- Assets: `python tools/fetch_assets.py`, see `credits/ASSET_LICENSES.md`.
- **Catches:** what bites is rolled by the server in three steps: rarity (70/22/7/1 for Common/Rare/Epic/Legendary), then a species of that rarity from the **spot's own pool** (`pool` in `src/data/spots.json`; epics and the legendary only bite at the pier), then a weight within the species' range (`src/data/fish.json`). Landing a fish shows a catch card; Rare or better is announced to the other player.
- **Gear:** the rod sets reel power, the line sets how much tension it absorbs and the heaviest fish it is rated for (heavier fish pull the tension up faster), the bait shifts the rarity odds. All in `src/data/equipment.json`.
- **Saving:** the server keeps coins, bag and gear per player profile in a SQLite file (`data/fishing.sqlite`, override with `FT_DB=path`; `FT_DB=:memory:` = nothing saved). Your browser remembers who you are (localStorage); a second tab of the same browser gets its own profile. Local test mode saves to localStorage instead.
- **FishDex:** press **I**, tab *FishDex*. A species unlocks on its first catch; the personal best weight is kept even after you sell the fish. The catch card says NEW SPECIES / NEW RECORD.
- **Together:** the top-left scoreboard shows both players' fish, rare catches and biggest fish this session. Press **1-4** for emotes (Hi / Nice / Wow / heart), **Enter** to chat (type, or click a quick phrase like "Qua đây!"; Enter sends, Esc closes; 100 characters, anti-spam), **M** to mute. Sound effects are synthesised in the game.
- **Release:** see `credits/RELEASE_CHECKLIST.md`. `GET /health` is the uptime check.
- **Open Ocean (expansion):** at the end of the pier, stand beside the moored boat and press **B** to sail to a second map (and **B** at the harbour to come back). The boat moves faster than you walk and cannot cross islands. Fish from inside the ringed zones in any direction (SPACE, the bobber goes the way the boat points). Players on different maps do not see each other; a rare catch is announced to both. Needs an online room (the local test is lake-only).
- **Frozen Bay (third map):** at sea, sail to the north-east corner of the Open Ocean and press **B** at the "FROZEN BAY" portal. A snowy sea with icy islands, four fishing zones (Ice Floes, Frozen Bay, Glacier Edge, and the legendary Aurora Pool where the Aurora Ray bites after dark) and six new fish. It uses the same sailing rules and shared boats as the ocean; the portal at the south-west corner returns you. A new map is just data in `src/data/maps.js` (+ spots and fish).
- **Shared boat:** at sea, sail next to your friend and press **B** to climb aboard their boat (the one you board drives). The driver steers with WASD; the passenger looks around with WASD and can fish, chat and emote. **V** swaps seats, the passenger presses **B** to step off. A shared boat must be stopped to cast, and it holds still while the passenger has a line out. Only the driver can sail the crew into the harbour.
- **Boat tipping:** on a shared boat, if the driver sails sideways and the passenger leans (holds a direction key) the same way, the boat tilts ("WOBBLY!"); after about 2 seconds of that it flips: both players are dunked for 3.5 seconds (nothing is lost) and then back on their own boats. Steering into an island gives a small bump and screen shake.
- **Cartoon fighting (on foot, online):** everyone starts in **Friendly** mode (nobody can hit you). Press **F** to switch to **FIGHT** mode (your name shows [FIGHT]); two players can hit each other only when both are in FIGHT mode. Face your friend and press **J** slap, **K** push or **L** bonk. A hit knocks them back, makes them dizzy for a moment (stars) and drops their fishing line; nothing is lost or damaged. Each move has a cooldown, and you cannot go back to Friendly for a few seconds after a fight. Slap and bonk do nothing at sea, but on a shared boat **K** (push) or **H** (big push) shoves the other crew member overboard: they splash for 3.5 s and return to their own boat (both must be in FIGHT mode).
- **Falling in and rescue:** a **push** that meets water drops the victim into the lake: they swim slowly (blue tint, ring of water), cannot fish or fight, and climb out by themselves after a few seconds, or when they paddle back to the shore or the pier. A friend on dry land can press **R** to throw a lifebuoy (within about 4 tiles); the swimmer then has 5 seconds to press **G** to grab it and is pulled up beside the rescuer. Nothing is lost.
- **Anger, thrown fish and duels:** every hit, robbery or thrown fish fills your **ANGER** meter (shown on the controls line); when it is full (and your friend is in FIGHT mode) press **H** for one **BIG PUSH**: a long knockback that can drop them in the lake. **Z** throws a small fish or piece of junk from your bag at your friend: it flies slowly (dodge it!) and is not lost. **U** challenges your friend to a **duel** (they answer **Y** or **N**; accepting is the consent, so Friendly mode does not matter): after a 3 second countdown each has 100 health; **J** punch, **K** kick, **L** dodge, **H** shove; at 0 health (or after 90 s, the one with more) the match ends, the winner earns 60 coins (3 prizes a day), nobody loses anything.
- **Stealing fish:** for 3 seconds after your friend lands a fish, stand next to them and press **T** (both must be in FIGHT mode: Friendly mode is the safe mode). A timing duel starts for both: a needle sweeps along a bar, press **SPACE** to stop it; whoever is closest to the green middle keeps the fish (a tie or no press keeps it with its owner). The loser stumbles (stars, 1.2 s). One try per fish, then a 25 second cooldown; boss fish cannot be stolen. Stolen fish move between bags, no coins change hands, and the thief's bag needs room.
- **Random events (online):** about 1 in 14 casts brings up **junk** (old boot, tin can, message bottle, treasure map...), worth a coin or two (the map more); some junk comes up dressed as **LEGENDARY?!** until you land it. A rare **treasure chest** appears on the ground: both players stand near it and press **O** within 1.5 s of each other to split the coins. After a catch a **seagull** may swoop for your fish: wait for it to dive, then press **C** to shoo it (too early does nothing; too late and it keeps the fish; legendary fish and bosses are never taken). Every few minutes a **lucky spot** glows on the lake for a minute with better odds for rare fish (same for both players). Junk is not collected in the FishDex.
- **Giant fish:** more often than a boss, a **GIANT FISH SPOTTED!** (Giant Carp / Giant Trout, 45-110 kg) shows at a lake spot. It is an ordinary fish that is simply too heavy for one: both cast there, then it is the same two-player haul as the boss (one REEL, one EASE, roles swap) but gentler, with a 120-coin bounty each.
- **Co-op boss:** a minute and a half after the game starts, then every 4-7 minutes, **BOSS FISH SPOTTED!** appears: one of three bosses (**Ancient Catfish**, the faster **Storm Pike** or the heavy **Moss Titan**, each with its own rhythm) at a red-ringed lake spot for about 2.5 minutes. Both players cast there and hook it (the first has 30 s for the partner to join). Then the server runs the fight: one player holds **SPACE** to **REEL** (while the fish rests), the other holds **SPACE** to **EASE** the line (when the tension is high); every stage (Steady, Dashing, RAGE) the jobs swap. Win: both get the boss fish and 300 coins. Lose (the line snaps, it escapes, time runs out): the boss waits for another try. A decent rod helps; the weight of the fish does not matter.
- **Music:** a soft synthesised tune (nothing to license): the cozy lake theme by day, a slower night theme after dark, and a fast boss theme during the co-op fight. **M** mutes music and effects together.
- **Friendship, titles and memories (online):** fishing next to your friend, rescues, shared boats, chests, bosses, contests and photos earn **friendship points** (they are never taken away by trolling): Fishing Buddies, Chaos Duo, Best Friends, Legendary Duo. Counters (fish, junk, steals, falls, rescues, bosses...) fill a **memory board**, and 14 **titles** (Fish Thief, King of Trash, Big Fish Hunter, Professional Troll, Boss Slayer...) unlock from them; wear one next to your name. Open it with **I** then the **Memories** tab. It is saved with your profile.
- **Fish Rush (the fish duel):** every few minutes a **RARE SPLASH!** gold ring appears at a lake spot for 10 seconds. Both players race there: the first to cast gets the rare or epic fish on their line (then it is a normal reeling fight and it can still get away); the other is too late. Counts on the memory board.
- **Fight buttons and the arena:** in FIGHT mode the moves appear on screen. On a phone they form a moba-style cluster in the bottom-right corner (a big basic attack with the other skills in an arc around it, each with a cooldown sweep; the big shove shows the anger meter). On a computer they are a skill bar at the bottom-right showing each key (J K L H Z). A **duel** (U, the other answers Y/N) is fought in the **ARENA**, a boxing ring drawn on the lake shore: both fighters are put at its ends, cannot leave the ropes (shoves stop at them) and go back where they were when it ends; the buttons turn into punch / kick / dodge / shove.
- **Phones and tablets:** on a touch screen (or add `?touch=1` to the address to try it on a computer) on-screen controls appear: a stick on the left for walking and sailing, a big green FISH button (hold it to reel) and BOAT / SHOP / BAG / STOP on the right, CHAT and MORE at the top (MORE opens FIGHT, throw, rescue, steal, duel, emotes, seat, sound and BACK). The buttons press the same keys as the keyboard, so every feature works. The chat box has Send and Close buttons. Landscape is best.
- **Music levels:** the background music was very quiet (about -45 dB) and is now twice as loud, with a soft low-pass filter so the boss theme is not harsh. I could measure levels but not listen: please check by ear and adjust `volume` in `src/data/music.json`.
- **Mini contests:** every 5-9 minutes a 3-minute contest starts (Biggest Fish, Most Fish, Most Rare Fish, King of Trash, Fastest Catch: the shortest reeling fight wins): scores and a countdown show on the right, the winner gets 120 coins, the other 40 (80 each for a tie), and both get friendship points.
- **Hats (cosmetic):** buy a hat at the market (Gear tab, Hats: Straw Hat, Party Hat, Captain Cap, Cat Ears, Golden Crown) and equip it; it sits on your head and your friend sees it. Hats are tiny pixel pictures in `src/data/hats.json`, so adding one is data only. "No hat" takes it off.
- **Photo mode:** after a boss, a legendary catch or a new title, press **P** within 20 seconds to take a polaroid of the screen with a caption; **Save photo** downloads it. The picture stays in your browser.
- **Sky:** a shared day/night cycle (6 min) and weather (clear / rain / fog / storm, changing every 90 s) computed from the server's clock, so both players see the same sky. It changes how fast fish bite and shifts the rarity odds. Events (`src/data/events.json`: Morning Calm, Golden Hour, Moonlit Waters, Storm Surge) are config-driven too. The **Abyssal Nautilus** (boss) lives in the northern *Abyss* zone and only bites at dusk and night; it needs the best rod and line to beat and gets angrier as the fight drags on.
- **Map data:** maps are plain data in `src/data/maps.js` (size, movement `walk`/`boat`, water/land/solids, portals, spawns); collision, server validation and fishing read it, so another map needs no new rules code. Map-only art is streamed when you first travel there (`MAP_ASSETS`).

