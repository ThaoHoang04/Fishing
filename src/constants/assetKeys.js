// Single source of truth for texture / animation keys.
// Convention: <category>_<name>[_<variant>], all lower snake_case. Files live in public/assets/<category>/.
// Every file listed here is produced by tools/normalize_assets.py; `pack` is the ID in credits/ASSET_LICENSES.md
// (tests/assets.test.mjs checks that every shipped file is accounted for there).
export const SCENES = {
  BOOT: 'BootScene',
  LOBBY: 'LobbyScene',
  LOAD_MAP: 'LoadMapScene',
  GAME: 'GameScene',
};

// Row order used by every 4-direction sheet (A2 Tiny Coast).
export const DIRECTIONS = ['down', 'left', 'up', 'right'];

// One skin per room slot (the server assigns slot 0 / 1); only those two are shipped.
export const PLAYER_SKINS = [1, 2];
export const playerKey = (skin, action) => `char_player${skin}_${action}`; // action: idle | walk | fish

export const TEXTURES = {
  WATER_GRASS: 'map_water_grass',
  SHOP_STALL: 'map_shop_stall', // generated in BootScene (no pack ships a market stall)
  DOCK_PLANK: 'map_dock_plank', // generated in BootScene (no pack ships a walkable pier tile)
  PROP_TREE: 'map_prop_tree',
  PROP_BUSH: 'map_prop_bush',
  PROP_ROCK: 'map_prop_rock',
  PROP_SIGN: 'map_prop_sign',
  PROP_GRASS: 'map_prop_grass',
  FISH_ICONS: 'fish_icons_16',
  FISHING_SPOT: 'fishing_spot',
  VFX_BOBBER_BITE: 'vfx_bobber_bite',
  VFX_CALM_RIPPLE: 'vfx_calm_ripple',
  VFX_SHALLOW_STEP: 'vfx_shallow_step',
  UI_COIN: 'ui_coin',
  BOAT: 'ocean_boat',
  OCEAN_WATER: 'ocean_water',
};

const T = TEXTURES;

export const IMAGES = [
  { key: T.PROP_TREE, path: 'assets/map/prop_tree.png', pack: 'A2' },
  { key: T.PROP_BUSH, path: 'assets/map/prop_bush.png', pack: 'A2' },
  { key: T.PROP_ROCK, path: 'assets/map/prop_rock.png', pack: 'A2' },
  { key: T.PROP_SIGN, path: 'assets/map/prop_sign.png', pack: 'A2' },
  { key: T.PROP_GRASS, path: 'assets/map/prop_grass.png', pack: 'A2' },
  { key: T.FISHING_SPOT, path: 'assets/fishing/fishing_spot.png', pack: 'A1' },
  { key: T.UI_COIN, path: 'assets/ui/coin.png', pack: 'A2' },
];

export const SPRITESHEETS = [
  ...PLAYER_SKINS.flatMap((s) => [
    { key: playerKey(s, 'idle'), path: `assets/characters/player${s}_idle.png`, frameWidth: 16, frameHeight: 16, pack: 'A2' },
    { key: playerKey(s, 'walk'), path: `assets/characters/player${s}_walk.png`, frameWidth: 16, frameHeight: 16, pack: 'A2' },
    { key: playerKey(s, 'fish'), path: `assets/characters/player${s}_fish.png`, frameWidth: 32, frameHeight: 32, pack: 'A2' },
  ]),
  { key: T.WATER_GRASS, path: 'assets/map/water_grass.png', frameWidth: 16, frameHeight: 16, pack: 'A2' },
  { key: T.FISH_ICONS, path: 'assets/fish/fish_icons_16.png', frameWidth: 16, frameHeight: 16, pack: 'A2' },
  { key: T.VFX_BOBBER_BITE, path: 'assets/vfx/bobber_bite.png', frameWidth: 64, frameHeight: 64, pack: 'A6' },
  { key: T.VFX_CALM_RIPPLE, path: 'assets/vfx/calm_ripple.png', frameWidth: 64, frameHeight: 64, pack: 'A6' },
  { key: T.VFX_SHALLOW_STEP, path: 'assets/vfx/shallow_step.png', frameWidth: 64, frameHeight: 64, pack: 'A6' },
  // The lake shows a moored boat, so the boat sheet is part of the first load.
  { key: T.BOAT, path: 'assets/ocean/boat.png', frameWidth: 64, frameHeight: 64, pack: 'A8' },
];

// Assets that belong to one map only are fetched when the player first travels there (LoadMapScene),
// so the first load stays as small as before. Same shape as SPRITESHEETS.
export const MAP_ASSETS = {
  lake: [],
  ocean: [
    { key: T.OCEAN_WATER, path: 'assets/ocean/water.png', frameWidth: 16, frameHeight: 16, pack: 'A8' },
  ],
  frost: [], // sails on the ocean's art (see MAP_ART_FROM)
};

// A map that borrows another map's art: the Frozen Bay uses the ocean's water.
export const MAP_ART_FROM = { frost: 'ocean' };

// Animation keys: <texture>_<direction> for characters, <texture> for VFX.
export const animKey = (textureKey, direction) => (direction ? `${textureKey}_${direction}` : textureKey);
