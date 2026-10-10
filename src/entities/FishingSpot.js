import { TEXTURES } from '../constants/assetKeys.js';
import { FACING_VECTOR, FISHING } from '../systems/FishingRules.js';

export const SPOT_RADIUS = FISHING.SPOT_RADIUS; // px between the player's feet and the spot's standing point

export default class FishingSpot {
  constructor(scene, data) {
    this.id = data.id;
    this.x = data.x; // standing point (feet)
    this.y = data.y;
    this.facing = data.facing;
    this.highlighted = false;

    // The marker floats over the water the player will cast into.
    const [vx, vy] = FACING_VECTOR[this.facing];
    const mx = this.x + vx * 28;
    const my = this.y + vy * 28;
    this.marker = scene.add.image(mx, my, TEXTURES.FISHING_SPOT, 'marker').setOrigin(0.5, 1).setScale(0.5).setDepth(my + 100);
    this.baseY = my;
    this.tween = null;
    this.setHighlight(false);
  }

  distanceTo(px, py) {
    return Math.hypot(px - this.x, py - this.y);
  }

  setHighlight(on) {
    if (on === this.highlighted && this.tween !== null) return;
    this.highlighted = on;
    this.marker.setAlpha(on ? 1 : 0.6);
    this.marker.setScale(on ? 0.65 : 0.5);
    this.tween?.remove();
    this.marker.y = this.baseY;
    this.tween = on
      ? this.marker.scene.tweens.add({ targets: this.marker, y: this.baseY - 3, duration: 450, yoyo: true, repeat: -1 })
      : { remove() {} };
  }
}
