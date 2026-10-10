import { STEAL, duelScore, isStealable, thiefWins } from '../src/systems/Steal.js';
import { getMap } from '../src/data/maps.js';
import { ANGER_STOLEN } from '../src/systems/Combat.js';

/**
 * Fish stealing, server side. It remembers each player's latest landed fish for a few seconds, starts a timing duel when
 * the other player asks to grab it, judges the two presses on the server's clock and moves the fish if the thief wins.
 * Nothing here trusts the client: who is near, who is in Friendly mode, what is in whose bag, and how good a press was.
 */
export default class Steals {
  /**
   * @param {{rooms: object, economy: object, species: object[], now: () => number, emit: (player, event, payload) => void,
   *          bagChanged: (player) => void, config?: object}} opts
   */
  constructor({ rooms, economy, species, now, emit, bagChanged, config = {}, social = null }) {
    this.social = social;
    this.rooms = rooms;
    this.economy = economy;
    this.species = new Map(species.map((s) => [s.id, s]));
    this.now = now;
    this.emit = emit;
    this.bagChanged = bagChanged;
    this.cfg = { ...STEAL, ...config };
    this.duels = new Map(); // room code -> duel
  }

  /** A fish was just landed and is in `player`'s bag: for a few seconds the other player may try to steal it. */
  noteCatch(player, item) {
    const species = this.species.get(item.speciesId);
    player.lastCatch = isStealable(species) ? { itemId: item.id, speciesId: item.speciesId, at: this.now() } : null;
    if (!player.lastCatch) return;
    for (const other of this.rooms.neighbours(player)) {
      this.emit(other, 'steal:open', { pid: player.pid, speciesId: item.speciesId, ms: this.cfg.WINDOW_MS });
    }
  }

  /** `thief` asks to grab the fish the player next to them just landed. Starts the timing duel if everything allows it. */
  start(thief) {
    const now = this.now();
    if (thief.room.phase !== 'playing' || !thief.connected) return { ok: false, error: 'NOT_PLAYING' };
    if (getMap(thief.mapId).movement !== 'walk' || thief.seat) return { ok: false, error: 'NOT_HERE' };
    if (thief.swimming) return { ok: false, error: 'SWIMMING' };
    if (now < thief.stunnedUntil) return { ok: false, error: 'STUNNED' };
    if (this.duels.has(thief.room.code)) return { ok: false, error: 'DUEL_ACTIVE' };
    if (thief.friendly) return { ok: false, error: 'FRIENDLY' };
    if (now < (thief.stealReadyAt ?? 0)) return { ok: false, error: 'COOLDOWN', ms: thief.stealReadyAt - now };
    const victim = thief.room.players.find((p) => p !== thief && p.connected && p.mapId === thief.mapId && !p.seat && !p.swimming
      && Math.hypot(p.x - thief.x, p.y - thief.y) <= this.cfg.RANGE);
    if (!victim) return { ok: false, error: 'NO_TARGET' };
    if (victim.friendly) return { ok: false, error: 'TARGET_FRIENDLY' };
    const loot = victim.lastCatch;
    if (!loot || now - loot.at > this.cfg.WINDOW_MS + this.cfg.SLACK_MS) return { ok: false, error: 'NOTHING_TO_STEAL' };
    if (this.economy.isFull(thief.profileId)) return { ok: false, error: 'BAG_FULL' };
    if (!this.economy.state(victim.profileId).items.some((i) => i.id === loot.itemId)) return { ok: false, error: 'NOTHING_TO_STEAL' };

    thief.stealReadyAt = now + this.cfg.COOLDOWN_MS;
    victim.lastCatch = null; // one attempt per fish
    const startAt = now + this.cfg.LEAD_MS;
    const duel = { thief, victim, loot, startAt, endAt: startAt + this.cfg.DUEL_MS, scores: new Map(), timer: null };
    // Both stand still for the duel.
    thief.stunnedUntil = victim.stunnedUntil = duel.endAt + 200;
    thief.moving = victim.moving = false;
    duel.timer = setTimeout(() => this.#resolve(duel), this.cfg.LEAD_MS + this.cfg.DUEL_MS + 50);
    duel.timer.unref?.();
    this.duels.set(thief.room.code, duel);
    const payload = {
      thief: thief.pid, victim: victim.pid, speciesId: loot.speciesId, startIn: this.cfg.LEAD_MS, durationMs: this.cfg.DUEL_MS,
      period: this.cfg.PERIOD_MS, zone: this.cfg.ZONE,
    };
    this.emit(thief, 'steal:start', payload);
    this.emit(victim, 'steal:start', payload);
    return { ok: true };
  }

  /** One press of the stop button. Only the first press counts; before the needle starts it is ignored. */
  press(player) {
    const duel = this.duels.get(player.room.code);
    if (!duel || (player !== duel.thief && player !== duel.victim)) return { ok: false, error: 'NO_DUEL' };
    const now = this.now();
    if (now < duel.startAt) return { ok: false, error: 'TOO_EARLY' };
    if (now > duel.endAt) return { ok: false, error: 'TOO_LATE' };
    if (duel.scores.has(player.pid)) return { ok: false, error: 'ALREADY_PRESSED' };
    duel.scores.set(player.pid, duelScore(now - duel.startAt, this.cfg.PERIOD_MS));
    if (duel.scores.size === 2) this.#resolve(duel);
    return { ok: true };
  }

  /** A player left or dropped: end their duel with nothing changed. */
  cancelFor(player) {
    const duel = this.duels.get(player.room.code);
    if (!duel || (player !== duel.thief && player !== duel.victim)) return;
    clearTimeout(duel.timer);
    this.duels.delete(player.room.code);
    duel.thief.stunnedUntil = duel.victim.stunnedUntil = 0;
    for (const p of [duel.thief, duel.victim]) if (p !== player) this.emit(p, 'steal:result', { cancelled: true, thief: duel.thief.pid, victim: duel.victim.pid });
  }

  #resolve(duel) {
    if (this.duels.get(duel.thief.room.code) !== duel) return;
    clearTimeout(duel.timer);
    this.duels.delete(duel.thief.room.code);
    const { thief, victim, loot } = duel;
    const scores = { thief: duel.scores.get(thief.pid) ?? 1, victim: duel.scores.get(victim.pid) ?? 1 };
    let thiefWon = thiefWins(scores.thief, scores.victim);
    let weight = null;
    if (thiefWon) {
      const moved = this.economy.steal(victim.profileId, thief.profileId, loot.itemId);
      if (moved.ok) weight = moved.item.weight;
      else thiefWon = false; // sold, or the thief's bag filled up in the meantime: the owner keeps it
    }
    const loser = thiefWon ? victim : thief;
    const winner = thiefWon ? thief : victim;
    winner.stunnedUntil = 0;
    loser.stunnedUntil = this.now() + this.cfg.LOSER_STUN_MS;
    if (thiefWon) {
      this.rooms.addAnger?.(victim, ANGER_STOLEN); // being robbed makes you cross
      this.social?.stat(thief, 'stealsWon');
      this.social?.stat(victim, 'stealsLost');
      this.bagChanged(victim);
      this.bagChanged(thief);
    }
    const result = {
      thief: thief.pid, victim: victim.pid, thiefWon, speciesId: loot.speciesId, weight, scores, loser: loser.pid, stunMs: this.cfg.LOSER_STUN_MS,
    };
    this.emit(thief, 'steal:result', result);
    this.emit(victim, 'steal:result', result);
  }
}
