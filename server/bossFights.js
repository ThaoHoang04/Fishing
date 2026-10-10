import { ReelSim, reelParams, DT, TICK_RATE, REEL } from '../src/systems/ReelSim.js';

/**
 * The co-op boss, server side. A boss fish shows up at a lake spot now and then ("BOSS FISH SPOTTED!"). Both players cast
 * there; when both have hooked it the fight starts. One player holds REEL, the other holds EASE (relaxes the line); at each
 * stage of the fight the roles swap. Unlike a normal fish the fight runs here, tick by tick, with both players' buttons,
 * and everyone sees the same snapshots. Win and both players get the boss fish and a bounty.
 */
const DEFAULTS = {
  firstMs: 90_000, // first boss this long after the game starts...
  everyMs: [240_000, 420_000], // ...then every few minutes
  lifeMs: 150_000, // how long the boss stays at its spot
  coins: 300, // bounty for each player
  snapshotEvery: 3, // ticks (60 Hz) between snapshots: 20 per second
  maxCatchUp: 12, // never simulate more than this many ticks in one go
};

export default class BossFights {
  /**
   * @param {{rooms: object, fishing: object, economy: object, bosses: object[], behaviours: object, spots: string[], now?: () => number,
   *          rng?: () => number, emit: (player, event, payload) => void, emitRoom: (room, event, payload) => void,
   *          bagChanged: (player) => void, config?: object, schedule?: boolean, autoTick?: boolean}} o
   */
  constructor({ rooms, fishing, economy, bosses, behaviours, spots, now = Date.now, rng = Math.random, emit, emitRoom, bagChanged, config = {}, schedule = false, autoTick = true, social = null }) {
    Object.assign(this, { rooms, fishing, economy, behaviours, spots, now, rng, emit, emitRoom, bagChanged, schedule, social });
    this.bosses = new Map(bosses.map((b) => [b.id, b]));
    this.cfg = { ...DEFAULTS, ...config };
    this.fights = new Set();
    this.timer = null;
    if (autoTick) {
      this.timer = setInterval(() => this.tick(this.now()), 1000 / 60 * 2);
      this.timer.unref?.();
    }
  }

  close() {
    clearInterval(this.timer);
  }

  // ---- the boss appears and goes ----

  /** Called whenever a room changes: the first time it is playing, plan the first boss. */
  ensureScheduled(room) {
    if (!this.schedule || room.phase !== 'playing' || room.bossPlan) return;
    this.#plan(room, this.cfg.firstMs);
  }

  #plan(room, delay) {
    clearTimeout(room.bossPlan);
    room.bossPlan = setTimeout(() => this.spawn(room, undefined, this.#pick()), delay);
    room.bossPlan.unref?.();
  }

  /** A random boss or giant, by each one's `weight` (giants turn up more often than real bosses). */
  #pick() {
    const all = [...this.bosses.values()];
    let roll = this.rng() * all.reduce((n, b) => n + (b.weight ?? 1), 0);
    for (const b of all) if ((roll -= b.weight ?? 1) < 0) return b.id;
    return all[0].id;
  }

  /** The boss shows up at `spotId` (a random lake spot if omitted) for `lifeMs`. */
  spawn(room, spotId = this.spots[Math.floor(this.rng() * this.spots.length)], bossId = [...this.bosses.keys()][0]) {
    if (!this.rooms.rooms.has(room.code) || room.phase !== 'playing' || room.bossSpot) return false;
    const boss = this.bosses.get(bossId);
    const until = this.now() + this.cfg.lifeMs;
    const spot = { spotId, speciesId: boss.id, name: boss.name, giant: Boolean(boss.giant), until, timer: null };
    spot.timer = setTimeout(() => this.#leave(room, spot), this.cfg.lifeMs);
    spot.timer.unref?.();
    room.bossSpot = spot;
    this.emitRoom(room, 'boss:spot', { spotId, speciesId: boss.id, name: boss.name, giant: spot.giant, lifeMs: this.cfg.lifeMs });
    this.rooms.onChange(room);
    return true;
  }

  #leave(room, spot, caught = false) {
    if (room.bossSpot !== spot) return;
    clearTimeout(spot.timer);
    room.bossSpot = null;
    this.emitRoom(room, 'boss:gone', { spotId: spot.spotId, caught });
    this.rooms.onChange(room);
    if (this.schedule && this.rooms.rooms.has(room.code)) {
      const [lo, hi] = this.cfg.everyMs;
      this.#plan(room, lo + this.rng() * (hi - lo));
    }
  }

  // ---- casting and hooking ----

  /** A cast at the boss's spot brings up the boss (while there is no fight yet). Used as the fishing session's forced catch. */
  forced(player, spotId) {
    const spot = player?.room.bossSpot;
    if (!spot || spot.spotId !== spotId || player.room.fight) return null;
    const boss = this.bosses.get(spot.speciesId);
    return { speciesId: boss.id, weight: Math.round((boss.minWeight + (boss.maxWeight - boss.minWeight) * this.rng()) * 10) / 10 };
  }

  /** A player's line is on the boss. When both are hooked, the fight begins. */
  hooked(player, session) {
    const room = player.room;
    room.bossHooks ??= new Map();
    room.bossHooks.set(player.pid, session);
    const other = room.players.find((p) => p !== player && room.bossHooks.get(p.pid)?.state === 'coop' && this.fishing.get(p.pid) === room.bossHooks.get(p.pid));
    if (!other || room.fight) {
      this.emitRoom(room, 'boss:hooked', { pid: player.pid, spotId: session.spotId, joinMs: this.fishing.cfg.COOP_JOIN_MS });
      return;
    }
    this.#start(room, other, player, session.speciesId, session.weight);
  }

  #start(room, first, second, speciesId, weight) {
    const boss = this.bosses.get(speciesId);
    const gears = [first, second].map((p) => this.economy.gear(p.profileId));
    const gear = {
      reelPower: (gears[0].rod.reelPower + gears[1].rod.reelPower) / 2,
      lineStrength: 1 + ((gears[0].line.tensionBonus ?? 0) + (gears[1].line.tensionBonus ?? 0)) / 2,
    };
    // Two lines share the load, so a boss this big is not a "line too weak" problem: teamwork is the difficulty, not the weight.
    const params = reelParams(boss, this.behaviours, gear, null);
    const seed = Math.floor(this.rng() * 0xffffffff);
    const fight = {
      room, speciesId, weight, a: first, b: second, roles: { reel: first.pid, ease: second.pid },
      sim: new ReelSim(params, seed), held: { [first.pid]: false, [second.pid]: false }, stage: 0, last: this.now(), acc: 0, ticks: 0,
    };
    for (const p of [first, second]) {
      this.fishing.park(p.pid); // the line stays on the boss for the whole fight: no time-out
      p.stunnedUntil = Number.MAX_SAFE_INTEGER; // both stand still
      p.moving = false;
    }
    room.fight = fight;
    this.fights.add(fight);
    const stages = params.stages.map((s) => ({ at: s.at, label: s.label }));
    for (const p of [first, second]) {
      this.emit(p, 'boss:fight', {
        speciesId, name: boss.name, weight, roles: fight.roles, stages, maxDistance: REEL.MAX_DISTANCE, maxTension: REEL.MAX_TENSION,
        warn: REEL.WARN_TENSION, danger: REEL.DANGER_TENSION, timeout: params.timeout,
      });
    }
    this.#snapshot(fight);
  }

  // ---- the fight ----

  /** A player's button (SPACE) went down or up. What it does depends on their role right now. */
  input(player, held) {
    const fight = player.room.fight;
    if (!fight || (player !== fight.a && player !== fight.b)) return false;
    fight.held[player.pid] = Boolean(held);
    return true;
  }

  /** Advance every running fight to `nowMs`. Called by a timer; tests call it by hand with a fake clock. */
  tick(nowMs) {
    for (const fight of [...this.fights]) {
      fight.acc += nowMs - fight.last;
      fight.last = nowMs;
      let steps = Math.min(this.cfg.maxCatchUp, Math.floor(fight.acc / (DT * 1000)));
      fight.acc = Math.max(0, fight.acc - steps * DT * 1000);
      if (steps === 0 && fight.acc > DT * 1000 * this.cfg.maxCatchUp) fight.acc = 0;
      while (steps-- > 0 && !fight.sim.done) this.#step(fight);
      if (fight.sim.done) this.#end(fight, fight.sim.outcome);
    }
  }

  #step(fight) {
    const sim = fight.sim;
    sim.step(Boolean(fight.held[fight.roles.reel]), Boolean(fight.held[fight.roles.ease]));
    fight.ticks++;
    if (sim.stage !== fight.stage) {
      fight.stage = sim.stage;
      [fight.roles.reel, fight.roles.ease] = [fight.roles.ease, fight.roles.reel]; // swap jobs for the harder stage
      for (const p of [fight.a, fight.b]) this.emit(p, 'boss:roles', { roles: { ...fight.roles }, stage: fight.stage, label: sim.p.stages[fight.stage].label });
    }
    if (fight.ticks % this.cfg.snapshotEvery === 0) this.#snapshot(fight);
  }

  #snapshot(fight) {
    const s = fight.sim;
    const payload = { tick: fight.ticks, distance: s.distance, tension: s.tension, phase: s.phase, fake: s.fake, stage: fight.stage, roles: { ...fight.roles } };
    for (const p of [fight.a, fight.b]) this.emit(p, 'boss:state', payload);
  }

  #end(fight, outcome) {
    if (!this.fights.delete(fight)) return;
    const { room, a, b } = fight;
    room.fight = null;
    room.bossHooks?.clear();
    this.#snapshot(fight);
    const boss = this.bosses.get(fight.speciesId);
    const result = { giant: Boolean(boss.giant), outcome, speciesId: fight.speciesId, name: this.bosses.get(fight.speciesId).name, weight: fight.weight, coins: 0, fish: {} };
    if (outcome === 'caught') {
      result.coins = boss.bounty ?? this.cfg.coins;
      for (const p of [a, b]) {
        const stored = this.economy.addCatch(p.profileId, { speciesId: fight.speciesId, weight: fight.weight });
        result.fish[p.pid] = stored.ok;
        this.economy.grant(p.profileId, result.coins);
        this.rooms.recordCatch(p, { weight: fight.weight, rarity: 'legendary' });
        this.social?.landed(p, { species: this.bosses.get(fight.speciesId), weight: fight.weight });
        this.social?.stat(p, 'bossesTogether');
        this.bagChanged(p);
      }
    }
    if (outcome === 'caught') this.social?.together([a, b], 'bossTogether');
    for (const p of [a, b]) {
      p.stunnedUntil = 0;
      this.fishing.cancel(p.pid);
      this.emit(p, 'boss:result', result);
    }
    if (outcome === 'caught' && room.bossSpot) this.#leave(room, room.bossSpot, true); // the boss is gone for good
  }

  /** A player left or dropped: the fight (or their hook) is off, nothing is awarded. */
  cancelFor(player) {
    const room = player.room;
    room.bossHooks?.delete(player.pid);
    const fight = room.fight;
    if (!fight || (player !== fight.a && player !== fight.b)) return;
    this.fights.delete(fight);
    room.fight = null;
    room.bossHooks?.clear();
    for (const p of [fight.a, fight.b]) {
      p.stunnedUntil = 0;
      this.fishing.cancel(p.pid);
      if (p !== player) this.emit(p, 'boss:result', { outcome: 'cancelled', speciesId: fight.speciesId });
    }
  }
}

export { TICK_RATE };
