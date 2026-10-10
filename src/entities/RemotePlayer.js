import { playerKey, animKey } from '../constants/assetKeys.js';
import NameTag from './NameTag.js';
import Boat from './Boat.js';
import FishingView from './FishingView.js';
import { FISH_FRAME, rodTip, setFishPose, clearFishPose } from './fishPose.js';
import { FISHING } from '../systems/FishingRules.js';

const INTERP_DELAY_MS = 120; // render slightly in the past so there are always two snapshots to blend
const SNAP_DISTANCE = 48; // a jump this large is a correction/teleport: do not slide across the map
const KEEP_MS = 1000;

/**
 * The other player. Driven only by server-relayed snapshots; never touches input or collision.
 * Snapshots carry the sender's clock (`t`); we align it to ours with the smallest observed
 * (arrival - t) offset, which keeps playback smooth even when packets arrive unevenly.
 */
export default class RemotePlayer {
  constructor(scene, info, color, map = null) {
    this.pid = info.pid;
    this.skin = info.skin;
    this.x = info.x;
    this.y = info.y;
    this.facing = info.facing ?? 'down';
    this.moving = false;
    this.connected = info.connected;
    this.baseName = info.name;
    this.buffer = [];
    this.offset = null;
    this.fish = null; // {state, facing} while the other player has a line out
    this.seated = false; // a passenger: rides on `follow`'s boat instead of following their own snapshots
    this.follow = null;
    this.ride = { x: 0, y: 0 };
    this.view = null;
    this.sprite = scene.add.sprite(this.x, this.y, playerKey(this.skin, 'idle')).setOrigin(0.5, 1);
    this.label = new NameTag(scene, info.name, color);
    this.boat = map?.movement === 'boat' ? new Boat(scene, this.x, this.y, this.facing) : null; // at sea they sail too
    this.setConnected(info.connected);
    this.render();
  }

  pushState(s) {
    const offset = performance.now() - s.t;
    this.offset = this.offset === null ? offset : Math.min(this.offset, offset);
    this.buffer.push(s);
  }

  /** Knocked back by a hit: appear at the new spot at once, and drop snapshots that were already on their way. */
  knock(x, y) {
    this.buffer.length = 0;
    this.x = x;
    this.y = y;
  }

  /** Rod + bobber state relayed by the server ('wait' | 'bite' | 'hooked' | 'idle'). */
  setFishing({ state, bobber, facing }, instant = false) {
    if (state === 'idle' || !this.connected) return this.clearFishing();
    this.view ??= new FishingView(this.sprite.scene);
    const first = this.fish === null;
    this.fish = { state, facing };
    if (first && instant) {
      // Joined while the line was already out: no throw animation, the bobber is simply there.
      this.view.place(bobber);
      this.applyMode();
    } else if (first) {
      // Throw from the rod tip, exactly like the local player's cast.
      this.view.launch(rodTip(this.sprite.x, this.sprite.y, facing), bobber, FISHING.CAST_FLIGHT_MS, () => this.applyMode());
    } else {
      this.applyMode();
    }
  }

  applyMode() {
    if (this.fish) this.view.setMode({ bite: 'bite', hooked: 'thrash' }[this.fish.state] ?? 'rest');
  }

  clearFishing() {
    this.fish = null;
    this.view?.hide();
  }

  setConnected(connected) {
    if (!connected) this.clearFishing();
    this.connected = connected;
    this.sprite.setAlpha(connected ? 1 : 0.45);
    this.boat?.setAlpha(connected ? 1 : 0.45);
    this.label.setText(connected ? this.tagText ?? this.baseName : `${this.baseName} (offline)`);
    if (!connected) this.moving = false;
  }

  update(now, dt = 0.016) {
    if (this.connected && this.buffer.length > 0) this.interpolate(now);
    if (this.follow) {
      this.x = this.follow.x;
      this.y = this.follow.y;
    }
    this.render();
    this.view?.update(dt, rodTip(this.sprite.x, this.sprite.y, this.fish?.facing ?? this.facing), { x: this.sprite.x, y: this.sprite.y });
  }

  interpolate(now) {
    const st = now - INTERP_DELAY_MS - this.offset; // render time on the sender's clock
    const buf = this.buffer;
    while (buf.length > 2 && buf[1].t < st - KEEP_MS) buf.shift();

    let i = buf.length - 1;
    while (i > 0 && buf[i].t > st) i--;
    const from = buf[i];
    const to = buf[i + 1];
    if (!to) {
      this.apply(from.x, from.y, from);
      return;
    }
    const gap = Math.hypot(to.x - from.x, to.y - from.y);
    const f = gap > SNAP_DISTANCE || to.t === from.t ? 0 : Math.min(1, Math.max(0, (st - from.t) / (to.t - from.t)));
    this.apply(from.x + (to.x - from.x) * f, from.y + (to.y - from.y) * f, from);
  }

  apply(x, y, state) {
    this.x = x;
    this.y = y;
    this.facing = state.facing;
    this.moving = state.moving;
  }

  render() {
    this.sprite.setPosition(Math.round(this.x + this.ride.x), Math.round(this.y + this.ride.y)).setDepth(this.y + Math.max(this.ride.y, 0));
    this.label.place(this.sprite.x, this.sprite.y);
    this.boat?.place(this.x, this.y, this.fish?.facing ?? this.facing, this.moving);
    this.boat?.sprite.setVisible(!this.seated);
    if (this.fish) {
      const frame = this.fish.state === 'wait' ? FISH_FRAME.WAIT
        : this.fish.state === 'bite' && Math.floor(performance.now() / 90) % 2 ? FISH_FRAME.BITE : FISH_FRAME.WAIT;
      setFishPose(this.sprite, this.skin, this.fish.facing, this.fish.state === 'hooked' ? FISH_FRAME.BITE : frame);
      this.posed = true;
      return;
    }
    if (this.posed) {
      clearFishPose(this.sprite);
      this.posed = false;
    }
    this.sprite.play(animKey(playerKey(this.skin, this.moving && !this.boat ? 'walk' : 'idle'), this.facing), true);
  }

  destroy() {
    this.view?.destroy();
    this.boat?.destroy();
    this.sprite.destroy();
    this.label.destroy();
  }
}
