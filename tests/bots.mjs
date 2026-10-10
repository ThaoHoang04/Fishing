import { readFileSync } from 'node:fs';
import { ReelSim, reelParams } from '../src/systems/ReelSim.js';

const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
export const species = readJson('../src/data/fish.json');
export const behaviours = readJson('../src/data/behaviours.json');
export const byId = (id) => species.find((s) => s.id === id);

// Stand-ins for players. A bot is a factory returning `(sim) => reeling`; it only uses what a player can see.
const lagged = (ticks, pick) => () => {
  const seen = [];
  return (sim) => {
    seen.push({ phase: sim.phase, tension: sim.tension });
    return pick(seen[Math.max(0, seen.length - 1 - ticks)]);
  };
};

export const bots = {
  /** Holds the button the whole time. */
  masher: () => () => true,
  /** Reels while resting, lets go the moment the fish warns or pulls. `ms` = reaction time. */
  fishWatcher: (ms = 200) => lagged(Math.round(ms * 0.06), (s) => s.phase === 'rest' && s.tension < 82),
  /** Only watches the tension bar: reel until `limit`, then let go until it falls to 35 (reaction 0.2 s). */
  tensionWatcher: (limit) => () => {
    let on = true;
    const seen = [];
    return (sim) => {
      seen.push(sim.tension);
      const t = seen[Math.max(0, seen.length - 1 - 12)];
      if (on && t >= limit) on = false;
      else if (!on && t <= 35) on = true;
      return on;
    };
  },
};

/** Play one whole fight. Returns the finished sim plus the recorded input log (what the client sends). */
export function play(sp, bot, seed, gear, weight = null) {
  const sim = new ReelSim(reelParams(sp, behaviours, gear, weight), seed);
  const decide = bot();
  const toggles = [];
  let reeling = false;
  while (!sim.done) {
    const want = decide(sim);
    if (want !== reeling) {
      reeling = want;
      toggles.push(sim.tick);
    }
    sim.step(want);
  }
  return { sim, toggles };
}

export function catchRate(sp, bot, { n = 300, gear } = {}) {
  let caught = 0;
  for (let i = 1; i <= n; i++) if (play(sp, bot, i * 7919, gear).sim.outcome === 'caught') caught++;
  return caught / n;
}
