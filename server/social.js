import { cloneMeta, bump, best, once, addFriendship, earnTitles } from '../src/systems/Social.js';

/**
 * Keeps the friendship / memory-board side of each profile up to date: counters, friendship points and the titles they
 * earn. Every change is saved with the profile; new titles and levels are announced to the player.
 */
export default class SocialService {
  /** @param {{store: object, config: object, now: () => number, emit: (player, event, payload) => void, changed: (player) => void}} o */
  constructor({ store, config, now = Date.now, emit, changed, roomChanged = () => {}, economy = null }) {
    Object.assign(this, { store, config, now, emit, changed, roomChanged, economy });
  }

  /** The title shown next to a player's name, from their saved profile. */
  refreshTitle(player) {
    const meta = this.store.getProfile(player.profileId)?.meta;
    player.titleName = this.config.titles.find((t) => t.id === meta?.active)?.name ?? null;
  }

  /** Change one player's meta inside a transaction, then announce what they earned. */
  #edit(player, fn) {
    if (!player?.profileId) return;
    let fresh = [];
    let levelUp = null;
    this.store.transaction(() => {
      const profile = this.store.getProfile(player.profileId);
      if (!profile) return;
      const meta = cloneMeta(profile.meta);
      levelUp = fn(meta) ?? null;
      fresh = earnTitles(meta, this.config);
      profile.meta = meta;
      this.store.saveProfile(profile);
    });
    const before = player.titleName ?? null;
    this.refreshTitle(player);
    if ((player.titleName ?? null) !== before) this.roomChanged(player);
    for (const t of fresh) this.emit(player, 'social:toast', { kind: 'title', name: t.name });
    if (levelUp?.levelUp) this.emit(player, 'social:toast', { kind: 'level', name: this.config.levels[levelUp.level].name });
    this.changed(player);
  }

  /** A counter (stealsWon, fellInWater...). */
  stat(player, key, n = 1) {
    this.#edit(player, (m) => { bump(m, key, n); });
  }

  /** Friendship points for each of `players` (a shared moment). `reason` is a key of config.points. */
  together(players, reason, n = this.config.points[reason]) {
    for (const p of players) this.#edit(p, (m) => addFriendship(m, n, this.config.levels));
  }

  /** A fish (or junk, or a boss) was landed. Updates the memory board; friendship if the friend was close by. */
  landed(player, { species, weight, friend = null }) {
    this.#edit(player, (m) => {
      if (species.trash) {
        bump(m, 'junk');
        return null;
      }
      bump(m, 'caught');
      once(m, 'firstFishAt', this.now());
      best(m, 'biggest', weight, species.name, 'biggestSpecies');
      if (species.rarity === 'legendary') {
        bump(m, 'legendary');
        once(m, 'firstLegendaryAt', this.now());
      }
      return friend ? addFriendship(m, this.config.points.catchTogether, this.config.levels) : null;
    });
  }

  /** Which friend (if any) is close enough to count as fishing together. */
  friendNear(player) {
    return player.room.players.find((p) => p !== player && p.connected && p.mapId === player.mapId
      && Math.hypot(p.x - player.x, p.y - player.y) <= this.config.togetherRange) ?? null;
  }

  /** A photo was taken (the picture itself never leaves the browser). Counts it, and a little friendship if the friend is posing next to you. */
  photo(player) {
    const now = this.now();
    if (now < (player.photoReadyAt ?? 0)) return { ok: false, error: 'COOLDOWN' };
    player.photoReadyAt = now + this.config.photoCooldownMs;
    this.stat(player, 'photos');
    const friend = this.friendNear(player);
    if (friend) this.together([player, friend], 'photo');
    return { ok: true };
  }

  /**
   * The coin prize for winning a duel, but only a few times a day (so it cannot be farmed). Returns the coins paid, 0 if the
   * daily limit is used up.
   */
  duelPrize(player, { coins, dailyLimit }) {
    let paid = 0;
    this.#edit(player, (m) => {
      const day = new Date(this.now()).toISOString().slice(0, 10);
      const today = m.daily?.day === day ? m.daily : { day, duels: 0 };
      if (today.duels < dailyLimit) {
        today.duels++;
        paid = coins;
      }
      m.daily = today;
    });
    if (paid > 0) this.economy?.grant(player.profileId, paid);
    return paid;
  }

  /** Pick the title shown next to the name. Only an earned title can be chosen (or none). */
  chooseTitle(player, id) {
    const profile = this.store.getProfile(player.profileId);
    const meta = cloneMeta(profile?.meta);
    if (id !== null && !meta.titles.includes(id)) return { ok: false, error: 'NOT_EARNED' };
    this.#edit(player, (m) => { m.active = id; });
    return { ok: true };
  }
}
