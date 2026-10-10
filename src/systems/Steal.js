/**
 * Fish stealing: right after someone lands a fish, the other player may try to grab it. Both then play one round of
 * a timing bar and whoever stops the needle closest to the middle keeps the fish. Shared by the server (which judges)
 * and the client (which draws the bar).
 */
export const STEAL = {
  WINDOW_MS: 3000, // how long after a catch the fish can be stolen
  SLACK_MS: 500, // a little extra, so a slow connection does not lose the window
  RANGE: 40, // how close the thief must be (feet to feet)
  COOLDOWN_MS: 25000, // between two attempts by the same player
  LEAD_MS: 900, // "get ready" before the needle starts
  DUEL_MS: 2600, // how long the needle runs; no press by then = worst score
  PERIOD_MS: 1300, // one full sweep there and back
  ZONE: 0.07, // the "perfect" band around the middle, as a fraction of the bar (each side)
  LOSER_STUN_MS: 1200, // the loser stumbles (cartoon: stars, no harm)
};

/** Where the needle is, 0..1, `t` ms after the duel started: it sweeps from one end to the other and back. */
export function needleAt(t, period = STEAL.PERIOD_MS) {
  const phase = ((t % period) + period) % period / period;
  return phase < 0.5 ? phase * 2 : 2 - phase * 2;
}

/** How far from the middle the needle was when pressed: 0 is perfect, 0.5 the worst. */
export const duelScore = (t, period = STEAL.PERIOD_MS) => Math.abs(needleAt(t, period) - 0.5);

/** Fish that can never be stolen (the brief: boss and quest fish, and the rarest tier). */
export const isStealable = (species) => Boolean(species) && !species.boss && !species.quest && species.rarity !== 'mythic';

/**
 * Decide a duel. Scores are distances from the middle (a missing press counts as the worst, 1). The thief must be strictly
 * better; a tie, or nobody pressing, leaves the fish with its owner.
 */
export const thiefWins = (thiefScore, victimScore) => thiefScore < victimScore;
