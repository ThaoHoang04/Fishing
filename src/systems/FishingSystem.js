import { FISHING, landingPoint } from './FishingRules.js';
import { ReelSim, reelParams, DT, REEL } from './ReelSim.js';
import FishingView from '../entities/FishingView.js';
import { FISH_FRAME, rodTip } from '../entities/fishPose.js';
import ReelHud from '../ui/ReelHud.js';
import CatchCard from '../ui/CatchCard.js';
import { RARITY_STYLE } from '../ui/rarity.js';
import { isRareOrBetter } from './FishingRules.js';
import { TEXTURES } from '../constants/assetKeys.js';
import speciesData from '../data/allSpecies.js';
import behaviours from '../data/behaviours.json';

export const STATE = { IDLE: 'idle', AIM: 'aim', CAST: 'cast', WAIT: 'wait', BITE: 'bite', REEL: 'reel', COOP: 'coop', RESULT: 'result' };

const RESULT_MS = 1200;
const CATCH_MS = 3000; // longer so the catch can be admired
const MAX_STEPS_PER_FRAME = 4; // never let a long frame spiral into a burst of sim ticks

const SPECIES = new Map(speciesData.map((f) => [f.id, f]));
const FAKE_LEGENDARY = { name: 'LEGENDARY?!', icon: 127, rarity: 'legendary' }; // the golden carp's sprite

const ERROR_TEXT = {
  ALREADY_FISHING: 'Already fishing',
  TOO_FAR: 'Too far from the spot',
  BAD_CAST: 'Cast landed on shore',
  BAD_FACING: 'Point the boat where you want to cast',
  BOAT_MOVING: 'Stop the boat first',
  WRONG_MAP: 'You cannot fish that here',
  NOT_PLAYING: 'Not in a running game',
  INVENTORY_FULL: 'Bag full - sell fish at the market',
};

const FAIL_TEXT = {
  snapped: 'The line snapped!',
  escaped: 'It got away!',
  timeout: 'Too slow - it spat the hook',
  incomplete: 'It got away!',
  invalid: 'Catch rejected',
  alone: 'The boss slipped away: your partner never hooked it',
};

/**
 * Per-player fishing state machine: IDLE -> AIM -> CAST -> WAIT -> BITE -> REEL -> RESULT.
 * The server (or the local backend) owns the timers and the roll; this class only drives input,
 * the character pose, the meters and the bobber. REEL runs the deterministic ReelSim locally (no
 * network round-trip while reeling) and records the input so the server can replay and confirm it.
 * Anything that ends a session goes through RESULT (short message) and back to IDLE, so every path
 * leaves the player in a clean state.
 *
 * Input is { action, cancel }: objects with `isDown`. Edges are detected here so composite keys work.
 */
export default class FishingSystem {
  /**
   * @param {Phaser.Scene} scene
   * @param {import('../entities/Player.js').default} player
   * @param {{cast, hook, finish, cancel, available: boolean, on: Function, off: Function}} backend
   * @param {{action: {isDown: boolean}, cancel: {isDown: boolean}}} keys
   */
  constructor(scene, player, backend, keys) {
    this.scene = scene;
    this.player = player;
    this.backend = backend;
    this.keys = keys;
    this.view = new FishingView(scene);
    this.meter = scene.add.graphics().setDepth(9500);
    this.hud = new ReelHud(scene);
    this.hudVisible = false; // set by the scene for the camera-followed player
    this.bagFull = false; // set by the scene from the inventory: no point starting a fight you cannot keep
    this.catchIcon = scene.add.image(0, 0, TEXTURES.FISH_ICONS, 0).setScale(2).setVisible(false);
    this.sparkles = scene.add.graphics().setDepth(9601);
    this.card = new CatchCard(scene);

    this.state = STATE.IDLE;
    this.hint = '';
    this.cooldown = 0;
    this.prevAction = false;
    this.prevCancel = false;
    this.token = 0; // invalidates async replies that belong to an abandoned attempt
    this.time = 0;
    this.sfx = scene.registry.get('sfx') ?? null;
    this.prevPhase = null;
    this.lastTick = 0;

    for (const event of ['bite', 'miss', 'fail', 'hooked', 'result', 'coophook']) backend.on(event, this[`on_${event}`], this);
    this.coop = null; // the co-op boss fight: {info, shown, target, held}
  }

  get isCoop() {
    return this.state === STATE.COOP;
  }

  get busy() {
    return this.state !== STATE.IDLE;
  }

  /** Sounds are only for the camera-followed player, so two local players do not talk over each other. */
  snd(name, arg) {
    if (this.hudVisible) this.sfx?.play(name, arg);
  }

  /** @param {number} dt seconds  @param {object|null} spot the spot the player is standing at */
  update(dt, spot) {
    this.time += dt;
    const down = this.keys.action.isDown;
    const pressed = down && !this.prevAction;
    const released = !down && this.prevAction;
    this.prevAction = down;
    const cancelDown = this.keys.cancel.isDown;
    const cancelPressed = cancelDown && !this.prevCancel;
    this.prevCancel = cancelDown;

    // (once the co-op fight is on there is no letting go: the line is tied to your partner's)
    if (cancelPressed && this.busy && this.state !== STATE.RESULT && !this.coop) this.cancel(this.state === STATE.REEL ? 'You let it go' : 'Reeled in');

    switch (this.state) {
      case STATE.IDLE:
        this.cooldown = Math.max(0, this.cooldown - dt * 1000);
        this.hint = spot ? (this.bagFull ? 'Bag is full! Sell fish at the market (E)' : 'Hold SPACE to cast') : '';
        if (spot && pressed && this.cooldown === 0 && !this.bagFull) this.enterAim(spot);
        break;
      case STATE.AIM:
        this.charge(dt);
        if (released || !down) this.release();
        break;
      case STATE.CAST:
        if (this.landed && this.session) this.enterWait();
        break;
      case STATE.WAIT:
        if (pressed) this.pull();
        break;
      case STATE.BITE:
        this.biteLeft -= dt * 1000;
        if (pressed) this.pull();
        break;
      case STATE.REEL:
        this.reel(dt, down);
        break;
      case STATE.COOP:
        this.coopUpdate(dt, down);
        break;
      case STATE.RESULT:
        this.timer -= dt * 1000;
        if (this.timer <= 0) this.reset();
        break;
      default:
    }

    this.updatePose();
    const p = this.player;
    this.view.update(dt, rodTip(p.sprite.x, p.sprite.y, p.facing), { x: p.sprite.x, y: p.sprite.y });
    this.drawMeter();
    this.drawHud(dt);
    this.updateCatchIcon();
  }

  // --- transitions ---

  enterAim(spot) {
    this.token++;
    this.spot = spot;
    this.session = null;
    this.landed = false;
    this.power = 0;
    this.sweep = 1;
    this.state = STATE.AIM;
    this.player.locked = true;
    // A point spot has a fixed casting direction; from a boat in a zone you cast the way the boat is pointing.
    if (spot.type !== 'zone') this.player.facing = spot.facing;
    this.setFrame(FISH_FRAME.READY);
    this.hint = 'Release SPACE to cast  (X cancels)';
  }

  charge(dt) {
    this.power += (this.sweep * dt * 1000) / FISHING.CHARGE_MS;
    if (this.power >= 1) {
      this.power = 1;
      this.sweep = -1;
    } else if (this.power <= 0) {
      this.power = 0;
      this.sweep = 1;
    }
  }

  release() {
    if (!this.backend.available) return this.showResult('No connection');
    const power = Math.max(FISHING.MIN_POWER, this.power);
    const token = this.token;
    this.state = STATE.CAST;
    this.setFrame(FISH_FRAME.CAST);
    this.hint = '';

    const p = this.player;
    const origin = this.spot.type === 'zone' ? { x: p.x, y: p.y, facing: p.facing } : this.spot;
    const to = landingPoint(origin, power);
    this.landing = to;
    this.snd('cast');
    this.view.launch(rodTip(p.sprite.x, p.sprite.y, p.facing), to, FISHING.CAST_FLIGHT_MS, () => {
      if (token === this.token) {
        this.landed = true;
        this.snd('splash');
      }
    });

    this.backend.cast(this.spot.id, power, p.facing).then(
      (res) => {
        if (token !== this.token) return;
        if (res.ok) this.session = res.session;
        else this.showResult(ERROR_TEXT[res.error] ?? 'Cast failed');
      },
      () => token === this.token && this.showResult('No connection'),
    );
  }

  enterWait() {
    this.state = STATE.WAIT;
    this.setFrame(FISH_FRAME.WAIT);
    this.hint = 'Waiting for a bite...  (X reels in)';
  }

  /** Hook (or, before the bite, pull too early). The server decides which it was. */
  pull() {
    if (this.pulled) return;
    this.pulled = true;
    this.snd('hook');
    this.backend.hook(this.session.id).then(
      (res) => {
        if (!res.ok && res.error === 'NO_SESSION') this.cancel('The line went slack');
      },
      () => this.cancel('No connection'),
    );
  }

  cancel(message) {
    this.token++;
    if (this.state === STATE.AIM) message = 'Cancelled'; // nothing was cast yet, so nothing to tell the server
    else this.backend.cancel().catch(() => {});
    this.showResult(message);
  }

  showResult(text, ms = RESULT_MS) {
    this.state = STATE.RESULT;
    this.timer = ms;
    this.hint = text;
    this.view.hide();
    this.hud.hide();
    this.pulled = false;
    this.session = null;
    this.sim = null;
  }

  reset() {
    this.state = STATE.IDLE;
    this.cooldown = FISHING.COOLDOWN_MS;
    this.hint = '';
    this.pulled = false;
    this.session = null;
    this.sim = null;
    this.catching = null;
    this.view.hide();
    this.hud.hide();
    this.player.locked = false;
    this.player.fishingFrame = null;
  }

  // --- reeling ---

  startReel({ id, speciesId, seed, weight, gear, fake }) {
    this.species = SPECIES.get(speciesId);
    this.fake = Boolean(fake); // junk dressed up as a legendary until it is landed
    // Exactly what the server will replay: the species' behaviour, this fish's weight and the gear that was
    // equipped when the line was cast (a line too weak for a heavy fish makes the tension climb faster).
    const params = reelParams(this.species, behaviours, gear, weight);
    this.sim = new ReelSim(params, seed);
    this.weight = weight;
    this.overweight = params.overweight;
    this.archetype = behaviours[this.species.behaviour].name;
    this.acc = 0;
    this.reeling = false;
    this.toggles = []; // tick numbers at which the reel button changed: the server replays this
    this.state = STATE.REEL;
    this.prevPhase = null;
    this.localOutcome = null;
    this.hint = '';
    this.view.setMode('rest');
    this.scene.events.emit('fishing:hooked', { id, speciesId, seed });
  }

  /** Fixed-step sim, driven by real time: the same fight plays out the same on any frame rate. */
  reel(dt, down) {
    const sim = this.sim;
    this.acc += dt;
    let steps = 0;
    while (this.acc >= DT && !sim.done) {
      if (down !== this.reeling) {
        this.reeling = down;
        this.toggles.push(sim.tick);
      }
      sim.step(down);
      this.acc -= DT;
      if (++steps >= MAX_STEPS_PER_FRAME) {
        this.acc = 0;
        break;
      }
    }

    // Audio cues: a tick while reeling, a warning blip when the fish is about to pull, a rumble while it pulls.
    if (down && this.time - this.lastTick > 0.14) {
      this.lastTick = this.time;
      this.snd('reel');
    }
    if (sim.phase !== this.prevPhase) {
      if (sim.phase === 'telegraph') this.snd('warn');
      else if (sim.phase === 'pull') this.snd('pull');
      this.prevPhase = sim.phase;
    }

    // The bobber slides toward the rod as the fish is reeled in, and out again when it pulls.
    const tip = rodTip(this.player.sprite.x, this.player.sprite.y, this.player.facing);
    const f = Math.max(0, Math.min(1, sim.distance / sim.p.startDistance));
    this.view.setPosition(tip.x + (this.landing.x - tip.x) * f, tip.y + (this.landing.y - tip.y) * f);
    this.view.setMode(sim.phase === 'pull' ? 'thrash' : 'rest');

    if (sim.done) this.endReel();
  }

  endReel() {
    const { outcome } = this.sim;
    const session = this.session;
    const { toggles, species } = this;
    // Remember what to expect BEFORE asking: the local backend answers synchronously.
    this.confirmId = session.id;
    this.localOutcome = outcome;
    this.backend.finish(session.id, toggles).catch(() => {}); // the server's replay answers via 'result'

    if (outcome === 'caught') {
      this.catching = species;
      this.showResult(`Caught a ${species.name}!`, CATCH_MS);
      // Holding the fish up: face the camera, standing idle, the fish raised overhead (see updateCatchIcon).
      this.player.facing = 'down';
      this.player.fishingFrame = null;
    } else {
      this.snd(outcome === 'snapped' ? 'snap' : 'fail');
      this.showResult(FAIL_TEXT[outcome] ?? 'It got away!');
      this.player.fishingFrame = FISH_FRAME.WAIT;
    }
  }

  // --- backend events (always for our own session) ---

  matches(e) {
    return this.session && this.session.id === e.id;
  }

  on_bite(e) {
    if (!this.matches(e) || (this.state !== STATE.WAIT && this.state !== STATE.CAST)) return;
    this.state = STATE.BITE;
    this.biteLeft = e.windowMs;
    this.biteWindow = e.windowMs;
    this.setFrame(FISH_FRAME.BITE);
    this.view.setMode('bite');
    this.snd('bite');
    this.hint = 'A bite! Press SPACE!';
  }

  on_miss(e) {
    if (this.matches(e)) {
      this.snd('fail');
      this.showResult('The fish got away...');
    }
  }

  on_fail(e) {
    if (this.matches(e)) {
      this.snd('fail');
      this.showResult(e.reason === 'early' ? 'Too early! You scared it.' : FAIL_TEXT[e.reason] ?? 'The line snapped');
    }
  }

  /** The co-op boss took the hook: we wait for our partner, and then the server runs the fight. */
  on_coophook(e) {
    if (!this.matches(e)) return;
    this.state = STATE.COOP;
    this.species = SPECIES.get(e.speciesId);
    this.coop = null;
    this.setFrame(FISH_FRAME.BITE);
    this.view.setMode('thrash');
    this.hint = 'Hooked the BOSS! Your partner must cast here too...';
    this.snd('hook');
  }

  /** The server started the fight: both players are on the boss. Show the shared HUD. */
  startCoop(info) {
    if (this.state !== STATE.COOP) return;
    this.coop = { info, me: this.backend.myPid, target: null, shown: null, held: false, stage: 0, banner: '', bannerUntil: 0, roles: info.roles };
    this.hint = '';
    this.snd('boss');
  }

  coopSnapshot(s) {
    if (!this.coop) return;
    this.coop.target = s;
    this.coop.roles = s.roles;
    this.coop.shown ??= { ...s };
  }

  coopRoles(r) {
    if (!this.coop) return;
    this.coop.roles = r.roles;
    this.coop.stage = r.stage;
    this.coop.banner = `${r.label.toUpperCase()}! SWAP JOBS`;
    this.coop.bannerUntil = this.time + 2.2;
    this.snd('boss');
  }

  /** The fight is over (caught, lost, or the partner left). */
  endCoop(res) {
    const info = this.coop?.info;
    this.coop = null;
    if (this.state !== STATE.COOP) return;
    this.hud.hide();
    if (res.outcome === 'caught') {
      const species = SPECIES.get(res.speciesId);
      this.lastCatch = { speciesId: res.speciesId, weight: res.weight, rarity: 'legendary', isNew: false, record: false };
      this.catching = { icon: species.icon, rarity: 'legendary' };
      if (this.hudVisible) this.card.show(species, res.weight, { boss: true, coop: true, giant: Boolean(res.giant), coins: res.coins });
      this.snd('boss', 'legendary');
      this.scene.events.emit('fishing:caught', { ...this.lastCatch, fisher: this });
      this.showResult('BOSS DEFEATED!', CATCH_MS);
    } else if (res.outcome === 'cancelled') {
      this.showResult('Your partner left: the boss got away');
    } else {
      this.snd('fail');
      this.showResult({ snapped: 'The line snapped! The boss got away', escaped: 'The boss got away!', timeout: 'Too slow: the boss got away' }[res.outcome] ?? 'The boss got away');
    }
    void info;
  }

  /** While the fight runs: tell the server whether SPACE is held, and ease the displayed bars towards the latest snapshot. */
  coopUpdate(dt, down) {
    const c = this.coop;
    if (!c) return;
    if (down !== c.held) {
      c.held = down;
      this.backend.bossInput?.(down);
    }
    if (!c.target) return;
    const k = Math.min(1, dt * 14);
    const t = c.target;
    c.shown.distance += (t.distance - c.shown.distance) * k;
    c.shown.tension += (t.tension - c.shown.tension) * k;
    c.shown.phase = t.phase;
    c.shown.fake = t.fake;
    this.player.fishingFrame = t.phase === 'pull' && Math.floor(performance.now() / 70) % 2 ? FISH_FRAME.BITE : FISH_FRAME.WAIT;
  }

  on_hooked(e) {
    if (this.matches(e)) this.startReel(e);
  }

  /** The server replayed our input. It should agree with the local sim; if not, its word wins. */
  on_result(e) {
    if (e.id !== this.confirmId) return;
    this.confirmId = null;
    if (e.outcome !== this.localOutcome) {
      this.catching = null;
      this.hint = FAIL_TEXT[e.outcome] ?? 'Catch rejected';
      this.scene.events.emit('fishing:rejected', { speciesId: e.speciesId, outcome: e.outcome });
    } else if (e.outcome === 'caught') {
      // Confirmed by the server: weight and rarity come from its roll, not from the client.
      const species = SPECIES.get(e.speciesId);
      this.lastCatch = { speciesId: e.speciesId, weight: e.weight, rarity: e.rarity, isNew: e.isNew, record: e.record };
      if (this.hudVisible) this.card.show(species, e.weight, { isNew: e.isNew, record: e.record, boss: e.boss, trash: e.trash, fake: e.fake, chest: e.chest });
      this.snd(e.boss ? 'boss' : e.chest ? 'rare' : e.trash ? 'fail' : 'catch', e.rarity);
      if (!e.trash && (e.isNew || e.record)) this.scene.time.delayedCall(450, () => this.snd(e.isNew ? 'discover' : 'record'));
      this.scene.events.emit('fishing:caught', { ...this.lastCatch, fisher: this });
    }
    this.scene.events.emit('fishing:result', e);
  }

  // --- presentation ---

  setFrame(frame) {
    this.player.fishingFrame = frame;
  }

  updatePose() {
    if (this.state === STATE.BITE) {
      this.player.fishingFrame = Math.floor(performance.now() / 90) % 2 ? FISH_FRAME.BITE : FISH_FRAME.WAIT;
    } else if (this.state === STATE.REEL) {
      // Rod bends while the fish pulls; ordinary hold otherwise.
      const phase = this.sim.phase;
      const rate = phase === 'pull' ? 70 : phase === 'telegraph' ? 130 : 0;
      this.player.fishingFrame = rate && Math.floor(performance.now() / rate) % 2 ? FISH_FRAME.BITE : FISH_FRAME.WAIT;
    }
  }

  drawMeter() {
    const g = this.meter.clear();
    const p = this.player;
    let fill = null;
    let color = 0x7be08a;
    if (this.state === STATE.AIM) {
      fill = this.power;
      color = this.power > 0.8 ? 0xff6b6b : this.power > 0.45 ? 0xffd24d : 0x7be08a;
    } else if (this.state === STATE.BITE) {
      fill = Math.max(0, this.biteLeft / this.biteWindow);
      color = 0xffe14d;
    } else if (this.state === STATE.REEL && !this.hudVisible) {
      // No big HUD for this player (e.g. the other local player): compact tension bar over the head.
      fill = this.sim.tension / REEL.MAX_TENSION;
      color = this.sim.tension >= REEL.DANGER_TENSION ? 0xff4d4d : this.sim.tension >= REEL.WARN_TENSION ? 0xfacc15 : 0x4ade80;
    }
    if (fill === null) return;
    const w = 24;
    const x = Math.round(p.sprite.x - w / 2);
    const y = Math.round(p.sprite.y - 34);
    g.fillStyle(0x000000, 0.8).fillRect(x - 1, y - 1, w + 2, 5);
    g.fillStyle(color, 1).fillRect(x, y, Math.round(w * fill), 3);
  }

  drawHud(dt) {
    if (this.state === STATE.COOP && this.coop?.shown && this.hudVisible) {
      const c = this.coop;
      const role = c.roles.reel === c.me ? 'reel' : 'ease';
      const stage = c.info.stages[c.stage]?.label ?? '';
      const banner = this.time < c.bannerUntil ? c.banner : '';
      const roleLine = banner || (role === 'reel' ? `YOU REEL: hold SPACE while it rests - ${stage}` : `YOU EASE: hold SPACE when the line is tight - ${stage}`);
      this.hud.draw({ ...c.shown, enraged: false }, this.species, role === 'reel' ? 'Co-op' : 'Co-op', dt, { weight: c.info.weight, role, roleLine });
      return;
    }
    if (this.state === STATE.REEL && this.hudVisible) this.hud.draw(this.sim, this.fake ? FAKE_LEGENDARY : this.species, this.archetype, dt, { weight: this.weight, overweight: this.overweight });
    else this.hud.hide();
  }

  /** The caught fish is held up over the player's head, with sparkles for rare and better. */
  updateCatchIcon() {
    const icon = this.catchIcon;
    const g = this.sparkles.clear();
    if (!this.catching || this.state !== STATE.RESULT) return icon.setVisible(false);
    const age = CATCH_MS - this.timer;
    const p = this.player;
    const x = Math.round(p.sprite.x);
    const y = Math.round(p.sprite.y - 30 - Math.min(8, age / 50));
    const pop = Math.max(0, 1 - age / 300); // little bounce when it appears
    icon.setVisible(true).setFrame(this.catching.icon).setPosition(x, y).setScale(2 + 0.5 * pop).setDepth(9600);

    if (isRareOrBetter(this.catching.rarity)) {
      g.fillStyle(RARITY_STYLE[this.catching.rarity].hex, 1);
      const t = age / 1000;
      for (let i = 0; i < 6; i++) {
        const a = t * 3 + (i * Math.PI) / 3;
        const r = 15 + Math.sin(t * 6 + i) * 2;
        g.fillRect(Math.round(x + Math.cos(a) * r) - 1, Math.round(y + Math.sin(a) * r) - 1, 2, 2);
      }
    }
  }

  destroy() {
    for (const event of ['bite', 'miss', 'fail', 'hooked', 'result', 'coophook']) this.backend.off(event, this[`on_${event}`], this);
    this.backend.destroy?.();
    this.view.destroy();
    this.meter.destroy();
    this.hud.destroy();
    this.catchIcon.destroy();
    this.sparkles.destroy();
    this.card.destroy();
  }
}
