// Reeling minigame simulation: pure, deterministic, fixed-step.
//
// Given the same fish params, seed and reel input, it always produces the same outcome. That lets the
// client run it locally for instant feel (no network round-trip while reeling) and the server replay the
// recorded input afterwards to confirm the result.

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;
export const REEL = {
  MAX_DISTANCE: 100, // fish gets away when it pulls the line this far out
  MAX_TENSION: 100, // the line snaps here
  WARN_TENSION: 60, // meter turns yellow
  DANGER_TENSION: 85, // meter turns red
  MAX_TOGGLES: 600, // cap on recorded input changes (anti-abuse for the replay)
  DEFAULT_GEAR: { reelPower: 14, lineStrength: 1 }, // distance units/s while reeling; divides tension gain
};

/** Small seeded PRNG (mulberry32): same seed -> same sequence on every machine. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build the sim parameters for a species: its behaviour archetype from data/behaviours.json, with the
 * species' `difficulty` scaling how hard the fish fights. No species is special-cased in code.
 *
 * `gear` = {reelPower, lineStrength, maxWeight}: rod power, how much tension the line absorbs, and the
 * heaviest fish the line is rated for. A fish heavier than the line's rating pulls the tension up faster
 * (up to 2.5x) - the cue to buy a better line. `weight` (kg) is the rolled weight of this fish.
 */
export function reelParams(species, behaviours, gear = REEL.DEFAULT_GEAR, weight = null) {
  const b = behaviours[species.behaviour];
  if (!b) throw new Error(`unknown behaviour "${species.behaviour}" for species "${species.id}"`);
  const k = species.difficulty ?? 1;
  const g = { ...REEL.DEFAULT_GEAR, ...gear };
  const over = g.maxWeight && weight && weight > g.maxWeight ? 1 + Math.min(1.5, (weight / g.maxWeight - 1) * 0.6) : 1;
  return {
    ...b,
    behaviour: species.behaviour,
    baseRise: b.baseRise * k * over,
    pullRise: b.pullRise * k * over,
    pullDrift: b.pullDrift * k,
    overweight: over > 1,
    weight,
    gear: g,
  };
}

export class ReelSim {
  /** @param {ReturnType<typeof reelParams>} params  @param {number} seed */
  constructor(params, seed) {
    this.p = params;
    this.rng = mulberry32(seed);
    this.tick = 0;
    this.distance = params.startDistance;
    this.tension = 0;
    this.phase = 'rest'; // 'rest' | 'telegraph' | 'pull'
    this.fake = false; // current telegraph is a bluff (trickster)
    this.phaseLeft = this.between(params.restMin, params.restMax);
    this.outcome = null; // null | 'caught' | 'snapped' | 'escaped' | 'timeout'
    this.pulls = 0;
    this.fakes = 0;
  }

  get time() {
    return this.tick * DT;
  }

  get done() {
    return this.outcome !== null;
  }

  /** Bosses get angrier the longer the fight drags on: shorter rests and harder pulls after `enrage.after` seconds. */
  get enraged() {
    const e = this.p.enrage;
    return Boolean(e) && this.time >= e.after;
  }

  /** Co-op bosses have stages (0, 1, 2...) that start at fixed times; each makes the fight harder. Other fish: always 0. */
  get stage() {
    const st = this.p.stages;
    if (!st) return 0;
    let i = 0;
    while (i + 1 < st.length && this.time >= st[i + 1].at) i++;
    return i;
  }

  /** How much harder the fish fights right now: `key` is 'rise' (tension gain) or 'rest' (shorter rests when above 1... scaled down). */
  scale(key) {
    const st = this.p.stages;
    if (st) return st[this.stage][key] ?? 1;
    const e = this.p.enrage;
    if (!e || !this.enraged) return 1;
    return key === 'rise' ? e.riseScale : e.restScale;
  }

  between(lo, hi) {
    return lo + this.rng() * (hi - lo);
  }

  /**
   * Advance one fixed tick. `reeling` = is the reel button held during this tick. `easing` (co-op only) = a second
   * player is relaxing the line: the tension drops faster, whatever the reeler is doing.
   */
  step(reeling, easing = false) {
    if (this.outcome) return this.outcome;
    const p = this.p;
    const pulling = this.phase === 'pull';

    if (reeling) {
      const power = p.gear.reelPower * (pulling ? 1 - p.pullResist : 1);
      this.distance -= power * DT;
      const anger = this.scale('rise');
      this.tension += (((p.baseRise + (pulling ? p.pullRise : 0)) * anger) / p.gear.lineStrength) * DT;
    } else {
      this.tension -= p.fall * DT;
      this.distance += (pulling ? p.pullDrift : p.drift) * DT; // letting go gives the fish line
    }
    if (easing) this.tension -= (p.easeRate ?? p.fall * 1.4) * DT;
    this.tension = Math.max(0, this.tension);
    this.tick++;

    this.phaseLeft -= DT;
    if (this.phaseLeft <= 0) this.nextPhase();

    if (this.distance <= 0) this.outcome = 'caught';
    else if (this.tension >= REEL.MAX_TENSION) this.outcome = 'snapped';
    else if (this.distance >= REEL.MAX_DISTANCE) this.outcome = 'escaped';
    else if (this.time >= p.timeout) this.outcome = 'timeout';
    return this.outcome;
  }

  // Fish behaviour timeline. It only consumes the seeded rng, never the player's input, so for a given
  // seed the fish always fights the same way (and the server's replay agrees with the client).
  nextPhase() {
    const p = this.p;
    const rest = () => this.between(p.restMin, p.restMax) * this.scale('rest');
    if (this.phase === 'rest') {
      if ((p.ambushChance ?? 0) > 0 && this.rng() < p.ambushChance) {
        // Ambush: a real pull with no warning (trickster). Telegraph-watchers get caught out.
        this.pulls++;
        this.phase = 'pull';
        this.phaseLeft = this.between(p.pullMin, p.pullMax);
        return;
      }
      this.fake = this.rng() < p.fakeChance;
      this.phase = 'telegraph';
      this.phaseLeft = this.between(p.telegraph[0], p.telegraph[1]);
      if (this.fake) this.phaseLeft *= 0.7; // bluffs are slightly shorter: a tell for sharp players
    } else if (this.phase === 'telegraph') {
      if (this.fake) {
        this.fakes++;
        this.phase = 'rest';
        this.phaseLeft = rest();
      } else {
        this.pulls++;
        this.phase = 'pull';
        this.phaseLeft = this.between(p.pullMin, p.pullMax);
      }
    } else {
      this.phase = 'rest';
      this.phaseLeft = rest();
    }
  }
}

/**
 * Replay a recorded input: `toggles` are the tick numbers at which the reel button changes state,
 * starting released. Runs until the sim ends or the log runs out.
 * @returns {{outcome: string|null, tick: number, sim: ReelSim}}  outcome null = log ended before the fight did
 */
export function replay(params, seed, toggles, maxTicks = Math.ceil(params.timeout * TICK_RATE) + 1) {
  const sim = new ReelSim(params, seed);
  let reeling = false;
  let i = 0;
  while (!sim.done && sim.tick < maxTicks) {
    while (i < toggles.length && toggles[i] <= sim.tick) {
      reeling = !reeling;
      i++;
    }
    sim.step(reeling);
  }
  return { outcome: sim.outcome, tick: sim.tick, sim };
}

/** Validate an input log from an untrusted client. */
export function validToggles(toggles, maxTick) {
  if (!Array.isArray(toggles) || toggles.length > REEL.MAX_TOGGLES) return false;
  let prev = -1;
  for (const t of toggles) {
    if (!Number.isInteger(t) || t < 0 || t > maxTick || t < prev) return false;
    prev = t;
  }
  return true;
}
