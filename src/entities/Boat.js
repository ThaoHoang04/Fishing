import { TEXTURES } from '../constants/assetKeys.js';

// The boat sheet (A8) is 4 columns x 8 rows of 64px frames. Rows 0-3 are the boat idling (left, right, up, down),
// rows 4-7 the same boat under way (with a wake). Four frames per row make one loop.
const ROW = { left: 0, right: 1, up: 2, down: 3 };
export const boatAnimKey = (facing, moving) => `boat_${moving ? 'sail' : 'idle'}_${facing}`;

/** Create the eight boat animations (call once, after the boat texture is loaded). */
export function createBoatAnims(anims) {
  for (const [facing, row] of Object.entries(ROW)) {
    for (const moving of [false, true]) {
      const key = boatAnimKey(facing, moving);
      if (anims.exists(key)) continue;
      const start = (moving ? row + 4 : row) * 4;
      anims.create({ key, frames: anims.generateFrameNumbers(TEXTURES.BOAT, { start, end: start + 3 }), frameRate: moving ? 8 : 4, repeat: -1 });
    }
  }
}

/**
 * The boat a character sits in. It is only a sprite: the character stays the logical entity (position, facing,
 * collision hull). `anchor` = the character's position; the hull is centred just above it.
 */
export default class Boat {
  constructor(scene, x, y, facing = 'up') {
    this.sprite = scene.add.sprite(x, y - 4, TEXTURES.BOAT, 0).setOrigin(0.5, 0.5);
    this.place(x, y, facing, false);
  }

  place(x, y, facing, moving) {
    this.sprite.setPosition(Math.round(x), Math.round(y) - 4).setDepth(y - 1);
    this.sprite.play(boatAnimKey(facing, moving), true);
  }

  setAlpha(a) {
    this.sprite.setAlpha(a);
  }

  destroy() {
    this.sprite.destroy();
  }
}
