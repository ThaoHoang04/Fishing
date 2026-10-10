"""Copy the chosen files from vendor/<ID>/x (extracted packs) into public/assets with clean names.

Usage:  python tools/normalize_assets.py
Run tools/fetch_assets.py first, then extract each archive into vendor/<ID>/x.

Only the files listed in MAP end up in the build. The pack each file came from is read off its source path
(the first path segment, e.g. "A2/x/...") and written to credits/asset_manifest.json, which the tests check
against credits/ASSET_LICENSES.md so no shipped file can be missing its license entry.
"""
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "vendor"
OUT = ROOT / "public" / "assets"
MANIFEST = ROOT / "credits" / "asset_manifest.json"

A1 = "A1/x/PinkSamurai_FishingPack"
A2 = "A2/x/Tiny Coast Pack"
A2_ADV = A2 + "/Tiny Adventure Pack"
A6 = "A6/x/top_down_water_interaction_starter_v1/SpriteSheets/64/clear_blue"
A8 = "A8/x/Pixel Islands - Free Seafaring Character Pack"

# (destination relative to public/assets, source relative to vendor)
MAP = [
    # Characters (A2): one skin per room slot. 16px idle/walk (4x4 grid), 32px rod animation (4x4 grid);
    # rows are down, left, up, right.
    *[(f"characters/player{i}_idle.png", f"{A2_ADV}/Character v2/Char{i}/Char{i}_idle_16px.png") for i in (1, 2)],
    *[(f"characters/player{i}_walk.png", f"{A2_ADV}/Character v2/Char{i}/Char{i}_walk_16px.png") for i in (1, 2)],
    *[(f"characters/player{i}_fish.png", f"{A2}/Characters/char{i}_fishingrod_animation_32x32.png") for i in (1, 2)],
    # Map (A2)
    ("map/water_grass.png", f"{A2}/Water/TS_Water.png"),
    ("map/prop_tree.png", f"{A2_ADV}/Other/Misc/Tree/Tree.png"),
    ("map/prop_bush.png", f"{A2_ADV}/Other/Misc/Bush.png"),
    ("map/prop_rock.png", f"{A2_ADV}/Other/Misc/Rock.png"),
    ("map/prop_sign.png", f"{A2_ADV}/Other/Misc/Sign.png"),
    ("map/prop_grass.png", f"{A2_ADV}/Other/Misc/Grass.png"),
    # Fish icons (A2) and the fishing spot marker (A1)
    ("fish/fish_icons_16.png", f"{A2}/Other/FishIcons_n_junk_16x16.png"),
    ("fishing/fishing_spot.png", f"{A1}/Fishing_Spot.png"),
    # VFX (A6 free starter): 64px frames, 4x4 grid, 16 frames @ 16 FPS, centered
    ("vfx/bobber_bite.png", f"{A6}/bobber_bite_4x4.png"),
    ("vfx/calm_ripple.png", f"{A6}/calm_ripple_4x4.png"),
    ("vfx/shallow_step.png", f"{A6}/shallow_step_4x4.png"),
    # UI (A2)
    ("ui/coin.png", f"{A2_ADV}/Other/Coin.png"),
    # Boat (A8): 64px frames, 4 columns x 8 rows. Rows 0-3 idle (left, right, up, down), rows 4-7 sailing.
    ("ocean/boat.png", f"{A8}/Boat/boat_no_player.png"),
    # Animated sea tile (A8): three 16px frames. Loaded only when the player first sails (see MAP_ASSETS).
    ("ocean/water.png", f"{A8}/Water/water_compact.png"),
]


def main():
    missing = [src for _, src in MAP if not (VENDOR / src).is_file()]
    if missing:
        print("Missing sources (run fetch_assets.py and extract into vendor/<ID>/x):")
        for m in missing:
            print("  -", m)
        sys.exit(1)

    if OUT.exists():
        shutil.rmtree(OUT)  # nothing stale survives: the folder is exactly what MAP lists
    manifest = {}
    for dst, src in MAP:
        target = OUT / dst
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(VENDOR / src, target)
        manifest[f"assets/{dst}"] = src.split("/")[0]
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(dict(sorted(manifest.items())), indent=2) + "\n", encoding="utf-8")
    print(f"Copied {len(MAP)} files into {OUT.relative_to(ROOT)}; wrote {MANIFEST.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
