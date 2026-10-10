import Phaser from 'phaser';
import Economy, { DEFAULT_GEAR, DEFAULT_OWNED } from './Economy.js';
import MemoryStore from './MemoryStore.js';
import speciesData from '../data/fish.json';
import equipmentData from '../data/equipment.json';

const KEY = 'ft_local_game';

/**
 * The same Economy the server runs, hosted in the browser for the offline "Local test" mode.
 * It is mirrored to localStorage, so coins, fish and gear survive a reload there too.
 */
export function createLocalEconomy(profileIds) {
  let snapshot = null;
  try {
    snapshot = JSON.parse(localStorage.getItem(KEY));
  } catch { /* nothing saved yet */ }
  const store = new MemoryStore({
    snapshot,
    persist: (s) => {
      try {
        localStorage.setItem(KEY, JSON.stringify(s));
      } catch { /* private mode / quota: progress just will not outlive the page */ }
    },
  });
  const economy = new Economy({ store, species: speciesData, equipment: equipmentData });
  for (const id of profileIds) {
    if (!store.getProfile(id)) {
      store.createProfile({ id, tokenHash: '', name: id, coin: 0, owned: [...DEFAULT_OWNED], equipped: { ...DEFAULT_GEAR }, createdAt: Date.now() });
    }
  }
  return economy;
}

/** One local player's view of the economy; same surface as NetworkSystem's trading methods. */
export class LocalEconomyClient extends Phaser.Events.EventEmitter {
  constructor(economy, profileId) {
    super();
    this.economy = economy;
    this.profileId = profileId;
  }

  get state() {
    return this.economy.state(this.profileId);
  }

  notify() {
    this.emit('inventory', this.state);
  }

  sell(ids) {
    return this.trade(() => this.economy.sell(this.profileId, ids));
  }

  sellAll() {
    return this.trade(() => this.economy.sellAll(this.profileId));
  }

  buy(id) {
    return this.trade(() => this.economy.buy(this.profileId, id));
  }

  equip(id) {
    return this.trade(() => this.economy.equip(this.profileId, id));
  }

  trade(run) {
    const res = run();
    if (res.ok) this.notify();
    return Promise.resolve({ ...res, state: this.state });
  }
}
