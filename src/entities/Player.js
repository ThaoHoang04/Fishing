import { playerKey, animKey } from '../constants/assetKeys.js';
import { moveFeet } from '../systems/Collision.js';
import { PLAYER_SPEED, BOAT_SPEED, SWIM_SPEED } from '../config.js';
import { LAKE_MAP } from '../data/maps.js';
import NameTag from './NameTag.js';
import Boat from './Boat.js';
import { setFishPose, clearFishPose } from './fishPose.js';

export default class Player {
  /**
   * @param {Phaser.Scene} scene
   * @param {{x:number, y:number, skin:number, name?:string, color?:string}} spawn  feet position + skin id (1-6)
   * @param {Record<'up'|'down'|'left'|'right', Phaser.Input.Keyboard.Key>} keys
   * @param {object} map  the map being played: on a boat map the character sails a boat instead of walking
   */
  constructor(scene, spawn, keys, map = LAKE_MAP) {
    this.scene = scene;
    this.map = map;
    this.skin = spawn.skin;
    this.keys = keys;
    this.x = spawn.x; // logical feet position (float); the sprite is drawn at the rounded position
    this.y = spawn.y;
    this.facing = 'down';
    this.moving = false;
    this.locked = false; // true while fishing: input is ignored
    this.seated = false; // a passenger on someone else's boat: looks around, does not steer
    this.held = false; // the boat holds still (its passenger has a line out)
    this.stunned = false; // dizzy after a hit: cannot move
    this.swimming = false; // in the water: slow, and water does not block
    this.leaning = false; // a passenger pressing a direction: shifts their weight (the boat may tip)
    this.bumped = false; // a boat that is being steered into something it cannot pass
    this.follow = null; // the boat's driver, whose position a passenger takes
    this.ride = { x: 0, y: 0 }; // where we sit on the boat, relative to its centre
    this.fishingFrame = null; // fishing pose frame (see fishPose.js), null = normal walk/idle sprite
    this.sprite = scene.add.sprite(this.x, this.y, playerKey(this.skin, 'idle')).setOrigin(0.5, 1);
    this.label = new NameTag(scene, spawn.name ?? '', spawn.color);
    this.boat = map.movement === 'boat' ? new Boat(scene, this.x, this.y, 'up') : null;
    this.updateAnimation();
  }

  update(dt) {
    const k = this.keys;
    const frozen = this.locked || this.held || this.stunned;
    const ix = frozen ? 0 : (k.right.isDown ? 1 : 0) - (k.left.isDown ? 1 : 0);
    const iy = frozen ? 0 : (k.down.isDown ? 1 : 0) - (k.up.isDown ? 1 : 0);
    this.moving = (ix !== 0 || iy !== 0) && !this.seated;
    this.leaning = this.seated && (ix !== 0 || iy !== 0);
    this.bumped = false;

    if (this.seated && (ix !== 0 || iy !== 0)) this.facing = this.pickFacing(ix, iy);
    if (this.moving) {
      const len = Math.hypot(ix, iy);
      const step = (this.swimming ? SWIM_SPEED : this.boat ? BOAT_SPEED : PLAYER_SPEED) * dt;
      const pos = moveFeet(this.x, this.y, (ix / len) * step, (iy / len) * step, this.map, this.swimming);
      this.bumped = Boolean(this.boat) && pos.x === this.x && pos.y === this.y; // pushing against an island or the edge
      this.x = pos.x;
      this.y = pos.y;
      this.facing = this.pickFacing(ix, iy);
    }

    if (this.follow) {
      this.x = this.follow.x;
      this.y = this.follow.y;
    }

    this.sprite.setPosition(Math.round(this.x + this.ride.x), Math.round(this.y + this.ride.y));
    this.sprite.setDepth(this.y + Math.max(this.ride.y, 0));
    this.label.place(this.sprite.x, this.sprite.y);
    this.boat?.place(this.x, this.y, this.facing, this.moving);
    this.boat?.sprite.setVisible(!this.seated); // a passenger sits in the driver's boat
    this.updateAnimation();
  }

  /** Server correction: snap the logical position (the sprite follows on the next update). */
  teleport(x, y) {
    this.x = x;
    this.y = y;
  }

  // Diagonal input keeps the current facing if it is one of the pressed axes, so it does not flicker.
  pickFacing(ix, iy) {
    const horizontal = ix > 0 ? 'right' : 'left';
    const vertical = iy > 0 ? 'down' : 'up';
    if (ix === 0) return vertical;
    if (iy === 0) return horizontal;
    return this.facing === horizontal || this.facing === vertical ? this.facing : horizontal;
  }

  updateAnimation() {
    if (this.fishingFrame !== null) {
      setFishPose(this.sprite, this.skin, this.facing, this.fishingFrame);
      this.posed = true;
      return;
    }
    if (this.posed) {
      clearFishPose(this.sprite);
      this.posed = false;
    }
    // A sailor sits in the boat: the boat animates, the character stays seated.
    const key = playerKey(this.skin, this.moving && !this.boat ? 'walk' : 'idle');
    this.sprite.play(animKey(key, this.facing), true);
  }
}
