// Internal render resolution: 480x270 = 16:9. At 3x -> 1440x810, at 4x -> 1920x1080.
// Keeping the internal size small and letting Scale.FIT zoom it keeps pixels sharp.
export const TILE_SIZE = 16;
export const GAME_WIDTH = 480;
export const GAME_HEIGHT = 270;

// Shared by client prediction and server validation.
export const PLAYER_SPEED = 60; // px/s on foot
export const SWIM_SPEED = 38; // px/s: slower than walking
export const BOAT_SPEED = 84; // px/s at sea
export const NET_SEND_HZ = 15;
