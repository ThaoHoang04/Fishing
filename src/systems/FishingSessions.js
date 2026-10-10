import { FISHING, RARITIES, FACING_VECTOR, isRareOrBetter, landingPoint } from './FishingRules.js';
import { isWaterAt } from './Collision.js';
import { getMap } from '../data/maps.js';
import { speciesAvailable } from './World.js';
import { reelParams, replay, validToggles, TICK_RATE } from './ReelSim.js';

/**
 * Authoritative fishing sessions, one per player: wait -> bite -> hooked | missed.
 * Pure logic with injected timers/rng so the same class runs on the server, in the browser
 * (offline local mode) and in unit tests.
 *
 * `emit(pid, event, payload)` events:
 *   'state'  {pid, state: 'wait'|'bite'|'hooked'|'idle', bobber, facing}   -> everyone in the room
 *
 * Two kinds of spot: a *point* (a fixed standing place and casting direction, on land or the pier) and a *zone*
 * (a circle of sea: a boat inside it may cast in any of the four directions). Each belongs to a map.
 *   'bite'   {id, windowMs}            -> the caster only
 *   'miss'   {id}                      -> the caster only
 *   'fail'   {id, reason: 'early'}     -> the caster only
 *   'hooked' {id, speciesId, seed, weight, gear} -> the caster only; the client now plays the reeling minigame
 *            with exactly these parameters (gear = the rod/line stats equipped at cast time)
 *   'result' {id, outcome, speciesId, tick, [weight, rarity, itemId, stored, isNew, record]} -> the caster only, after finish():
 *            the server's replay of the fight; the rest is included only for a catch
 *   'rare'   {id, speciesId, rarity, weight} -> a catch of rare or better: the host announces it to the room
 * The species, weight and seed are rolled at cast time (from the spot's fish pool) but only revealed once the
 * fish is hooked / landed.
 */
export default class FishingSessions {
  constructor({
    spots, species, trash = [], extra = [], behaviours, emit = () => {}, config = {}, rng = Math.random, now = Date.now, hooks = {},
    // Arrow wrappers: browsers throw "Illegal invocation" if setTimeout is called with `this` = this object.
    setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id),
  }) {
    this.spots = new Map(spots.map((s) => [s.id, s]));
    this.species = species;
    this.trash = trash; // junk and chests: only ever rolled by rollSpecial, never from a spot's pool
    this.speciesById = new Map([...species, ...trash, ...extra].map((f) => [f.id, f])); // `extra`: bosses, looked up but never rolled
    this.behaviours = behaviours;
    this.now = now;
    // Optional game hooks (the economy and the world): beforeCast(pid) -> error code | null, gear(pid) -> {rod, line, bait},
    // onCatch(pid, {speciesId, weight}) -> {ok, item}, conditions(pid, mapId) -> World.state() (time, weather, events,
    // modifiers). Without them the sessions run with default gear in neutral conditions.
    this.hooks = hooks;
    this.emit = emit;
    this.cfg = { ...FISHING, ...config };
    this.rng = rng;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.active = new Map(); // pid -> session
    this.counter = 0;
  }

  get(pid) {
    return this.active.get(pid) ?? null;
  }

  /** @param {{spotId: string, power: number, x: number, y: number, facing?: string, mapId?: string}} req  x,y = caster's feet / boat */
  cast(pid, { spotId, power, x, y, facing, mapId }) {
    if (this.active.has(pid)) return { ok: false, error: 'ALREADY_FISHING' };
    const spot = this.spots.get(spotId);
    if (!spot) return { ok: false, error: 'BAD_SPOT' };
    if (!Number.isFinite(power)) return { ok: false, error: 'BAD_POWER' };
    const spotMap = spot.map ?? 'lake';
    if (mapId !== undefined && mapId !== spotMap) return { ok: false, error: 'WRONG_MAP' };
    const zone = spot.type === 'zone';
    if (zone && !FACING_VECTOR[facing]) return { ok: false, error: 'BAD_FACING' };
    const reach = zone ? spot.r : this.cfg.SPOT_RADIUS;
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.hypot(x - spot.x, y - spot.y) > reach + this.cfg.SPOT_TOLERANCE) {
      return { ok: false, error: 'TOO_FAR' };
    }
    // A point casts from where it is, in the direction it faces; a zone casts from the boat, the way it is pointing.
    const origin = zone ? { x, y, facing } : spot;
    const blocked = this.hooks.beforeCast?.(pid);
    if (blocked) return { ok: false, error: blocked };
    const gear = this.hooks.gear?.(pid);
    const clamped = Math.min(1, Math.max(this.cfg.MIN_POWER, power));
    const bobber = landingPoint(origin, clamped, this.cfg);
    if (!isWaterAt(bobber.x, bobber.y, getMap(spotMap))) return { ok: false, error: 'BAD_CAST' };
    const world = this.hooks.conditions?.(pid, spotMap) ?? null;
    const baitMod = gear?.bait?.rarityModifier;
    const worldMod = world?.modifiers.rarityModifier;
    const luckyMod = world?.lucky?.spotId === spotId ? world.lucky.rarityModifier : null; // a glowing spot: better odds
    const rarityModifier = baitMod || worldMod || luckyMod
      ? Object.fromEntries(RARITIES.map((r) => [r, (baitMod?.[r] ?? 1) * (worldMod?.[r] ?? 1) * (luckyMod?.[r] ?? 1)]))
      : null;

    const c = this.cfg;
    const session = {
      id: String(++this.counter),
      pid,
      spotId,
      facing: origin.facing,
      mapId: spotMap,
      bobber,
      state: 'wait',
      ...(this.hooks.forcedCatch?.(pid, spotId) ?? this.rollSpecial() ?? this.rollCatch(spot, rarityModifier, world)),
      // What the fight is played with: fixed at cast time, so changing gear mid-fight changes nothing.
      reelGear: gear ? { reelPower: gear.rod.reelPower, lineStrength: 1 + (gear.line.tensionBonus ?? 0), maxWeight: gear.line.maxWeight } : undefined,
      seed: Math.floor(this.rng() * 0xffffffff),
      windowMs: Math.round(c.HOOK_MIN_MS + this.rng() * (c.HOOK_MAX_MS - c.HOOK_MIN_MS)),
      timer: null,
    };
    // Rain, storms and some events make the fish bite sooner (never faster than half the usual minimum).
    const biteMs = Math.round(Math.max(c.BITE_MIN_MS * 0.5, (c.BITE_MIN_MS + this.rng() * (c.BITE_MAX_MS - c.BITE_MIN_MS)) * (world?.modifiers.biteSpeed ?? 1)));
    session.timer = this.setTimer(() => this.bite(session), biteMs);
    this.active.set(pid, session);
    this.publish(session, 'wait');
    return { ok: true, session: { id: session.id, spotId, bobber, facing: session.facing, mapId: spotMap } };
  }

  hook(pid, id) {
    const s = this.active.get(pid);
    if (!s || s.id !== id) return { ok: false, error: 'NO_SESSION' };
    if (s.state === 'wait') {
      this.end(s);
      this.emit(pid, 'fail', { id, reason: 'early' });
      return { ok: true };
    }
    if (s.state !== 'bite') return { ok: false, error: 'BAD_STATE' };
    this.clearTimer(s.timer);
    if (this.speciesById.get(s.speciesId)?.coop) {
      // A co-op boss: the fight cannot start until the second player is on it too, and it is run by the server.
      s.state = 'coop';
      s.hookedAt = this.now();
      s.timer = this.setTimer(() => {
        this.end(s);
        this.emit(pid, 'fail', { id, reason: 'alone' });
      }, this.cfg.COOP_JOIN_MS);
      this.emit(pid, 'coophook', { id, speciesId: s.speciesId, joinMs: this.cfg.COOP_JOIN_MS });
      this.publish(s, 'hooked');
      this.hooks.onCoopHook?.(pid, s);
      return { ok: true };
    }
    s.state = 'hooked';
    s.hookedAt = this.now();
    // Stays registered (blocking new casts) until the client finishes/cancels; a TTL guards against abandoned sessions.
    s.timer = this.setTimer(() => this.end(s), this.cfg.HOOKED_TTL_MS);
    this.emit(pid, 'hooked', { id, speciesId: s.speciesId, seed: s.seed, weight: s.weight, gear: s.reelGear, ...(s.fake ? { fake: true } : {}) });
    this.publish(s, 'hooked');
    return { ok: true };
  }

  /**
   * The client ran the fight locally; replay its recorded input (`toggles`: ticks at which the reel
   * button changed state) against the same seed to get the authoritative outcome.
   * Outcomes: 'caught' | 'snapped' | 'escaped' | 'timeout' | 'incomplete' | 'invalid'. Only 'caught' is a catch.
   */
  finish(pid, id, toggles) {
    const s = this.active.get(pid);
    if (!s || s.id !== id) return { ok: false, error: 'NO_SESSION' };
    if (s.state !== 'hooked') return { ok: false, error: 'BAD_STATE' };
    const params = reelParams(this.speciesById.get(s.speciesId), this.behaviours, s.reelGear, s.weight);
    const maxTicks = Math.ceil(params.timeout * TICK_RATE) + 1;

    let outcome = 'invalid';
    let tick = 0;
    if (validToggles(toggles, maxTicks)) {
      const r = replay(params, s.seed, toggles, maxTicks);
      tick = r.tick;
      outcome = r.outcome ?? 'incomplete'; // the log ended before the fish was landed or lost
      // The fight cannot have taken less real time than its simulated length (with some network slack).
      const elapsedMs = this.now() - s.hookedAt;
      if (outcome === 'caught' && elapsedMs < (tick / TICK_RATE) * 1000 * 0.8 - 1000) outcome = 'invalid';
    }
    this.end(s);
    const sp = this.speciesById.get(s.speciesId);
    const result = { id, outcome, speciesId: s.speciesId, tick };
    if (outcome === 'caught') {
      const stored = this.hooks.onCatch?.(pid, { speciesId: s.speciesId, weight: s.weight, fightSec: tick / TICK_RATE });
      Object.assign(result, { weight: s.weight, rarity: sp.rarity, stored: stored ? stored.ok : true });
      if (sp.boss) result.boss = true;
      if (sp.trash) result.trash = true;
      if (sp.chest) result.chest = true;
      if (s.fake) result.fake = true;
      if (stored?.item) Object.assign(result, { itemId: stored.item.id, isNew: stored.isNew, record: stored.record });
    }
    this.emit(pid, 'result', result);
    if (outcome === 'caught' && isRareOrBetter(sp.rarity)) {
      this.emit(pid, 'rare', { id, speciesId: s.speciesId, rarity: sp.rarity, weight: s.weight });
    }
    return { ok: true, outcome };
  }

  /** Keep a hooked session alive without a time-out (the co-op fight takes over until it ends or is cancelled). */
  park(pid) {
    const s = this.active.get(pid);
    if (s) this.clearTimer(s.timer);
  }

  cancel(pid) {
    const s = this.active.get(pid);
    if (s) this.end(s);
    return { ok: true };
  }

  bite(s) {
    s.state = 'bite';
    this.emit(s.pid, 'bite', { id: s.id, windowMs: s.windowMs });
    this.publish(s, 'bite');
    s.timer = this.setTimer(() => {
      this.end(s);
      this.emit(s.pid, 'miss', { id: s.id });
    }, s.windowMs + this.cfg.HOOK_SLACK_MS);
  }

  end(s) {
    this.clearTimer(s.timer);
    if (this.active.get(s.pid) === s) this.active.delete(s.pid);
    this.emit(s.pid, 'state', { pid: s.pid, state: 'idle', bobber: null, facing: s.facing });
  }

  publish(s, state) {
    this.emit(s.pid, 'state', { pid: s.pid, state, bobber: s.bobber, facing: s.facing });
  }

  /**
   * Roll what is on the line, in three steps so rarity behaves predictably: rarity, then a species of that
   * rarity from the spot's pool, then a weight within the species' range. Never returns a fish outside the pool.
   * `rarityModifier` (bait x weather x events) multiplies the rarity odds; `world` filters species by time/weather.
   */
  rollCatch(spot, rarityModifier = null, world = null) {
    const all = spot.pool ? this.species.filter((f) => spot.pool.includes(f.id)) : this.species;
    // Some species only bite at certain times / in certain weather; if that would empty the pool, ignore it.
    const open = all.filter((f) => speciesAvailable(f, world));
    const pool = open.length > 0 ? open : all.filter((f) => !f.when);
    if (pool.length === 0) throw new Error(`spot "${spot.id}" has an empty fish pool`);

    const present = RARITIES.filter((r) => pool.some((f) => f.rarity === r));
    // The bait shifts the odds between rarities (e.g. a golden lure favours rare/epic/legendary).
    const rarity = this.pick(present, (r) => this.cfg.RARITY_WEIGHT[r] * (rarityModifier?.[r] ?? 1));
    const sp = this.pick(pool.filter((f) => f.rarity === rarity), (f) => f.catchWeight);
    const raw = sp.minWeight + (sp.maxWeight - sp.minWeight) * this.rng() ** this.cfg.WEIGHT_SKEW;
    const weight = Math.min(sp.maxWeight, Math.max(sp.minWeight, Math.round(raw * 100) / 100));
    return { speciesId: sp.id, weight };
  }

  /**
   * Junk or a treasure chest instead of a fish (only when the random events are on). One roll decides: a small slice
   * of casts brings up a chest, the next slice junk (and some junk is dressed up as a legendary until it is landed).
   * @returns {{speciesId: string, weight: number, fake?: boolean} | null}
   */
  rollSpecial() {
    const { CHEST_CHANCE: chest, TRASH_CHANCE: junk, FAKE_CHANCE: fake } = this.cfg;
    if (!(chest > 0 || junk > 0) || this.trash.length === 0) return null;
    const u = this.rng();
    let sp = null;
    if (u < chest) sp = this.trash.find((t) => t.chest);
    else if (u < chest + junk) sp = this.pick(this.trash.filter((t) => !t.chest), (t) => t.catchWeight);
    if (!sp) return null;
    const weight = Math.round((sp.minWeight + (sp.maxWeight - sp.minWeight) * this.rng()) * 100) / 100;
    return { speciesId: sp.id, weight, ...(sp.chest || !(this.rng() < fake) ? {} : { fake: true }) };
  }

  pick(items, weightOf) {
    const total = items.reduce((sum, item) => sum + weightOf(item), 0);
    let r = this.rng() * total;
    for (const item of items) {
      r -= weightOf(item);
      if (r < 0) return item;
    }
    return items[items.length - 1];
  }
}
