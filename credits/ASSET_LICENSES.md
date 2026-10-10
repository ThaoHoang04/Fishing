# Asset Licenses

Every file in `public/assets/` MUST have a row here (checked by `tests/assets.test.mjs` against
`credits/asset_manifest.json`, which `tools/normalize_assets.py` writes). "Free" / "name your own price" only
describes the download price. Raw archives live in `vendor/` (git-ignored, never redistributed). Store-page
snapshots taken at download time are in `credits/terms/`. If page and packaged terms differ, the packaged terms win.

Pipeline: `python tools/fetch_assets.py` → extract each archive into `vendor/<ID>/x/` → `python tools/normalize_assets.py`.

| ID | Pack | Author | URL | Terms (verified 2026-10-04) | Credit | Used in build |
|----|------|--------|-----|-----------------------------|--------|---------------|
| A1 | Pixel Art Fishing Pack | PinkSamurai | https://pinksamurai.itch.io/assets | Page FAQ: commercial use OK; credit asked for. **Forbidden: NFT / AI-training projects.** No license file in archive. | Required (FAQ: "as long as credit is given") | Yes - only the fishing spot marker (`fishing_spot.png`) |
| A2 | Tiny Coast Pack (v2) | Vryell | https://vryell.itch.io/tiny-coast-pack | Page: personal + commercial use; do NOT resell/redistribute. No license file in archive. | Not required, appreciated | Yes - characters, water/grass tiles, props, fish icons, coin |
| A3 | Fishing game asset pack [FREE] | benvoide | https://benvoide.itch.io/fishing-game | No license text on page or in archive. | Unknown | No - high-res (250px+) art, not pixel art; incompatible style |
| A4 | Free Fish assets | AGD-AwkwardGameDev | https://agdawkwardgamedev.itch.io/free-fish-assets | No license text on page or in archive ("No generative AI was used"). | Unknown | No - ask the author before any use |
| A5 | Free Fishing Pixel Art Pack | Free Game Assets (CraftPix) | https://free-game-assets.itch.io/free-fishing-pixel-art-pack | Archive `License.txt` → https://craftpix.net/file-licenses/ §2 Freebie: personal + commercial use, modification OK; no reselling/redistributing source art. | Not required, appreciated | No - its pier sheet was evaluated and dropped (pier planks are drawn in code) |
| A6 | Top-Down Water Interaction VFX - **Free Starter** | rio1222 | https://rio1222.itch.io/top-down-water-interaction-vfx | Archive `LICENSE.txt`: commercial + non-commercial use, modification OK; no resell/sublicense/redistribution of source files. AI-assisted code/docs disclosed; graphics procedural. | Not required, appreciated | Yes - bobber bite, calm ripple, shallow step |
| A7 | FREE Fishing Boats Pack | MutterPixel Studio | https://mutterpixel-studio.itch.io/free-fishing-boats-pack-animated-pixel-art-assets | No license text on page or in archive. AI-assisted graphics disclosed. | Unknown | No (post-MVP; verify terms first) |
| A8 | Pixel Islands - Free Seafaring Character Pack | dardasaba | https://dardasaba.itch.io/pixel-islands-free-seafaring-character-pack | Archive `README.txt`: personal + commercial, modification OK; no resell/redistribute without permission. | Not required, appreciated | Yes - the boat and the animated sea tile (Open Ocean) |

## Notes

- **A6 substitution:** the original link (`rio1222.itch.io/top-down-fishing-interaction-vfx`) returns 404. Replaced by the
  same author's *Top-Down Water Interaction VFX*; only the free starter upload (3 effects) is used. The full 12-effect set is $3.99.
- **A3 / A4 / A7** must not ship until the author confirms terms in writing.
- **Drawn in code (no pack):** the market stall and the pier planks are generated in `BootScene`; their palette was matched to the packs.
- **Sound:** every sound effect is synthesised at run time with WebAudio (`src/audio/Sfx.js`). There are no audio files.
- **A7 boats** (no license text) were passed over for **A8**'s boat, whose README clearly allows commercial use and modification.
- **FishDex art:** the FishDex uses the A2 fish icons (silhouettes for undiscovered fish). The larger A1 fish art is not used.

## Credits (shown under "Credits" in the lobby, `src/data/credits.json`)

- Fishing spot icon: PinkSamurai - https://pinksamurai.itch.io
- Tiny Coast Pack (characters, tiles, props, fish icons, UI): Vryell - https://vryell.itch.io
- Water interaction VFX: rio1222 - https://rio1222.itch.io
- Boat and sea tile (Pixel Islands pack): dardasaba - https://dardasaba.itch.io
