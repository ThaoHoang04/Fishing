import { DIRECTIONS, playerKey } from '../constants/assetKeys.js';

// The 32x32 fishing sheet (A2) has one row per direction (down, left, up, right) and four poses per row.
export const FISH_FRAME = { READY: 0, CAST: 1, WAIT: 2, BITE: 3 };

// Feet row inside each 32px frame, per facing: the body sits at a different baseline per direction,
// so the sprite origin is moved to keep the feet on the player's position.
const FEET_Y = { down: 23, left: 26, up: 24, right: 26 };

// Rod tip relative to the feet, per facing (measured on the WAIT pose). The fishing line starts here.
const ROD_TIP = { down: [-3, 5], left: [-15, -11], up: [3, -20], right: [14, -12] };

export const rodTip = (x, y, facing) => ({ x: x + ROD_TIP[facing][0], y: y + ROD_TIP[facing][1] });

/** Show a fishing pose on a character sprite (stops its walk/idle animation). */
export function setFishPose(sprite, skin, facing, frame) {
  sprite.anims.stop();
  sprite.setTexture(playerKey(skin, 'fish'), DIRECTIONS.indexOf(facing) * 4 + frame);
  sprite.setOrigin(0.5, FEET_Y[facing] / 32);
}

/** Back to the 16px walk/idle sprites; the caller restarts the animation. */
export function clearFishPose(sprite) {
  sprite.setOrigin(0.5, 1);
}
