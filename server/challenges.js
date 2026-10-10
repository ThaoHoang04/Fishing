/**
 * Mini contests between the two players: "who catches the biggest fish in 3 minutes", most fish, most rare fish, most junk.
 * A contest starts by itself every few minutes (with the random events on), tracks each landed fish, and ends with a small
 * reward for both (more for the winner) and a few friendship points.
 */
export default class Challenges {
  /**
   * @param {{rooms: object, economy: object, config: object, now?: () => number, rng?: () => number,
   *          emitRoom: (room, event, payload) => void, bagChanged: (player) => void, social?: object, schedule?: boolean}} o
   */
  constructor({ rooms, economy, config, now = Date.now, rng = Math.random, emitRoom, bagChanged, social = null, schedule = false }) {
    Object.assign(this, { rooms, economy, cfg: config, now, rng, emitRoom, bagChanged, social, schedule });
    this.kinds = new Map(config.kinds.map((k) => [k.id, k]));
  }

  ensureScheduled(room) {
    if (!this.schedule || room.phase !== 'playing' || room.challengePlan) return;
    this.#plan(room, this.cfg.firstMs);
  }

  #plan(room, delay) {
    clearTimeout(room.challengePlan);
    room.challengePlan = setTimeout(() => this.start(room), delay);
    room.challengePlan.unref?.();
  }

  /** Begin a contest (a random kind if none given). Needs two connected players in a running game and no contest on. */
  start(room, kindId = [...this.kinds.keys()][Math.floor(this.rng() * this.kinds.size)]) {
    const players = room.players.filter((p) => p.connected);
    if (!this.rooms.rooms.has(room.code) || room.phase !== 'playing' || room.challenge || players.length < 2) {
      if (this.schedule && !room.challenge && this.rooms.rooms.has(room.code)) this.#plan(room, 30_000); // not now: try again soon
      return false;
    }
    const kind = this.kinds.get(kindId);
    const startAt = this.now();
    const challenge = { kind: kind.id, name: kind.name, unit: kind.unit, startAt, endsAt: startAt + this.cfg.durationMs, scores: Object.fromEntries(players.map((p) => [p.pid, 0])), timer: null };
    challenge.timer = setTimeout(() => this.end(room), this.cfg.durationMs);
    challenge.timer.unref?.();
    room.challenge = challenge;
    this.emitRoom(room, 'challenge:start', { kind: kind.id, name: kind.name, text: kind.text, unit: kind.unit, durationMs: this.cfg.durationMs, scores: { ...challenge.scores } });
    this.rooms.onChange(room);
    return true;
  }

  /** A fish, or junk, was landed. Bosses are not part of the contest. */
  record(player, species, weight, fightSec = null) {
    const c = player.room.challenge;
    if (!c || !(player.pid in c.scores) || !species || species.boss) return;
    const isRare = !species.trash && species.rarity !== 'common';
    let changed = false;
    if (c.kind === 'heaviest' && !species.trash && weight > c.scores[player.pid]) {
      c.scores[player.pid] = weight;
      changed = true;
    } else if (c.kind === 'fastest' && !species.trash && Number.isFinite(fightSec) && fightSec > 0) {
      const best = c.scores[player.pid];
      const t = Math.round(fightSec * 10) / 10;
      if (best === 0 || t < best) {
        c.scores[player.pid] = t; // 0 = no catch yet; a lower time is better
        changed = true;
      }
    } else if (c.kind === 'most' && !species.trash) {
      c.scores[player.pid]++;
      changed = true;
    } else if (c.kind === 'rare' && isRare) {
      c.scores[player.pid]++;
      changed = true;
    } else if (c.kind === 'trash' && species.trash) {
      c.scores[player.pid]++;
      changed = true;
    }
    if (changed) this.emitRoom(player.room, 'challenge:score', { scores: { ...c.scores } });
  }

  /** Time is up. The winner has the higher score; equal scores (or nobody scoring) is a tie. */
  end(room) {
    const c = room.challenge;
    if (!c) return;
    clearTimeout(c.timer);
    room.challenge = null;
    const players = room.players.filter((p) => p.pid in c.scores);
    const connected = players.filter((p) => p.connected);
    const [a, b] = players;
    const sa = c.scores[a?.pid] ?? 0;
    const sb = c.scores[b?.pid] ?? 0;
    const lower = this.kinds.get(c.kind)?.lowerWins; // fastest catch: the shorter time wins, and no catch at all loses
    const better = lower ? (x, y) => x > 0 && (y === 0 || x < y) : (x, y) => x > y;
    const winner = connected.length < 2 || sa === sb ? null : better(sa, sb) ? a : better(sb, sa) ? b : null;
    const reward = this.cfg.reward;
    const result = { kind: c.kind, name: c.name, unit: c.unit, scores: { ...c.scores }, winner: winner?.pid ?? null, coins: {}, cancelled: connected.length < 2 };
    if (connected.length === 2) {
      for (const p of players) {
        const coins = winner ? (p === winner ? reward.winner : reward.loser) : reward.tie;
        result.coins[p.pid] = coins;
        this.economy.grant(p.profileId, coins);
        this.bagChanged(p);
      }
      this.social?.together(players, 'challenge');
      if (winner) this.social?.stat(winner, 'challengesWon');
    }
    this.emitRoom(room, 'challenge:end', result);
    this.rooms.onChange(room);
    if (this.schedule && this.rooms.rooms.has(room.code)) {
      const [lo, hi] = this.cfg.everyMs;
      this.#plan(room, lo + this.rng() * (hi - lo));
    }
  }

  /** A player left the room: the contest is called off. */
  cancelFor(player) {
    if (player.room.challenge) this.end(player.room);
  }
}
