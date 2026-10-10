import { mulberry32 } from './ReelSim.js';

/**
 * The shared world clock, weather and events. Everything is a pure function of (time, seed): the server and
 * every client compute the same answer from the same clock, so nothing has to be streamed tick by tick.
 * What the weather does is data (src/data/conditions.json, src/data/events.json), not code.
 */
export const RARITY_KEYS = ['common', 'rare', 'epic', 'legendary'];
export const BITE_SPEED_RANGE = [0.4, 1.5]; // multiplier on the bite delay: below 1 = fish bite sooner

/** A species with `when` only bites under those conditions (e.g. an after-dark creature). No `when` = always. */
export const speciesAvailable = (species, world) =>
  !species.when || !world
  || ((!species.when.time || species.when.time.includes(world.time)) && (!species.when.weather || species.when.weather.includes(world.weather)));

/**
 * @param {{conditions: object, events: object[], lucky?: {slotMs: number, lifeMs: number, maps: string[], spots: string[], rarityModifier: object} | null}} config
 *   lucky = a glowing fishing spot that appears now and then (off when null)
 */
export function createWorld({ conditions, events, lucky = null }) {
  const { dayMs, weatherSlotMs, phases, weatherOdds } = conditions;
  const weatherKinds = Object.keys(weatherOdds);
  const oddsTotal = weatherKinds.reduce((s, k) => s + weatherOdds[k], 0);

  /** Time of day: which phase, how far through the day (0..1) and how bright it is (0.12 night .. 1 day). */
  function timeOfDay(now) {
    const frac = (((now % dayMs) + dayMs) % dayMs) / dayMs;
    const phase = phases.find((p) => frac >= p.from && frac < p.to) ?? phases[phases.length - 1];
    const t = (frac - phase.from) / (phase.to - phase.from);
    const floor = 0.12;
    const daylight = phase.id === 'dawn' ? floor + (1 - floor) * t
      : phase.id === 'dusk' ? 1 - (1 - floor) * t
        : phase.id === 'day' ? 1 : floor;
    return { phase: phase.id, frac, daylight };
  }

  /** The weather of the 90 s slot containing `now`: the same for everyone who knows the seed. */
  function weatherAt(now, seed) {
    const slot = Math.floor(now / weatherSlotMs);
    let r = mulberry32((seed ^ Math.imul(slot, 0x9e3779b1)) >>> 0)() * oddsTotal;
    for (const kind of weatherKinds) {
      r -= weatherOdds[kind];
      if (r < 0) return kind;
    }
    return weatherKinds[0];
  }

  /**
   * The lucky spot (a glowing fishing spot with better odds) running at `now`, if any: each slot of `slotMs` has at most one,
   * starting at a seeded moment inside the slot and lasting `lifeMs`. The same for everyone who knows the seed.
   */
  function luckyAt(now, seed, mapId) {
    if (!lucky || !lucky.maps.includes(mapId) || lucky.spots.length === 0) return null;
    const slot = Math.floor(now / lucky.slotMs);
    const rng = mulberry32((seed ^ Math.imul(slot + 7919, 0x85ebca6b)) >>> 0);
    const start = slot * lucky.slotMs + Math.floor(rng() * (lucky.slotMs - lucky.lifeMs));
    const spotId = lucky.spots[Math.floor(rng() * lucky.spots.length)];
    return now >= start && now < start + lucky.lifeMs ? { spotId, until: start + lucky.lifeMs, rarityModifier: lucky.rarityModifier } : null;
  }

  const matches = (when, time, weather) =>
    (!when?.time || when.time.includes(time)) && (!when?.weather || when.weather.includes(weather));

  /** Events running on `mapId` right now. */
  function activeEvents(time, weather, mapId) {
    return events.filter((e) => e.maps.includes(mapId) && matches(e.when, time, weather));
  }

  /**
   * Everything the fishing rules need to know about the world at `now`: the conditions, which events run,
   * and the combined effect on rarity odds (multipliers per rarity) and bite speed.
   */
  function state(now, { seed = 0, mapId = 'lake' } = {}) {
    const tod = timeOfDay(now);
    const weather = weatherAt(now, seed);
    const active = activeEvents(tod.phase, weather, mapId);
    const rarityModifier = Object.fromEntries(RARITY_KEYS.map((r) => [r, 1]));
    let biteSpeed = 1;
    for (const source of [conditions.time[tod.phase], conditions.weather[weather], ...active.map((e) => e.effects)]) {
      if (!source) continue;
      for (const [r, m] of Object.entries(source.rarityModifier ?? {})) rarityModifier[r] *= m;
      biteSpeed *= source.biteSpeed ?? 1;
    }
    biteSpeed = Math.min(BITE_SPEED_RANGE[1], Math.max(BITE_SPEED_RANGE[0], biteSpeed));
    return {
      time: tod.phase, daylight: tod.daylight, dayFrac: tod.frac, weather,
      events: active.map((e) => e.id), modifiers: { rarityModifier, biteSpeed },
      lucky: luckyAt(now, seed, mapId),
    };
  }

  return { timeOfDay, weatherAt, activeEvents, luckyAt, state, config: { dayMs, weatherSlotMs, phases, weatherOdds } };
}

/** Client side of the shared clock: `offset` is how far the server's clock is ahead of ours. */
export const worldNow = (offset = 0, local = Date.now()) => local + offset;
