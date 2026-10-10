import speciesData from '../data/fish.json';
import allSpecies from '../data/allSpecies.js';
import equipmentData from '../data/equipment.json';
import { RARITY_STYLE, formatWeight } from './rarity.js';

const SPECIES = new Map(allSpecies.map((f) => [f.id, f])); // fish and junk (both can be in the bag)
const DEX_IDS = new Set(speciesData.map((f) => f.id)); // the FishDex is fish only
const dexCount = (dex) => Object.keys(dex ?? {}).filter((id) => DEX_IDS.has(id)).length;
const ICON_SHEET = 'assets/fish/fish_icons_16.png';
const ICON_COLUMNS = 6;
const GROUPS = [['rod', 'Rods'], ['line', 'Lines'], ['bait', 'Baits'], ['hat', 'Hats (just for looks)']];
const REGIONS = [['lake', 'Sunset Lake'], ['ocean', 'Open Ocean'], ['frost', 'Frozen Bay']];

const MESSAGES = {
  NOT_AT_SHOP: 'Walk up to the market stall to trade.',
  NOT_ENOUGH_COIN: 'Not enough coins.',
  ALREADY_OWNED: 'You already own that.',
  NOT_FOUND: 'That item is gone (already sold?).',
  NOTHING_TO_SELL: 'Your bag is empty.',
  NOT_OWNED: 'Buy it first.',
  BUSY: 'Finish fishing first: gear is locked while a line is out.',
  BAD_REQUEST: 'Something went wrong with that request.',
  NO_CONNECTION: 'No connection to the server.',
  NO_PROFILE: 'No player profile yet.',
  SERVER_ERROR: 'The server had a problem. Try again.',
};

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

let iconSheet = null;
const sheet = () => {
  if (!iconSheet) {
    iconSheet = new Image();
    iconSheet.src = ICON_SHEET;
  }
  return iconSheet;
};

function fishIcon(frame) {
  const canvas = el('canvas', { width: 32, height: 32, className: 'icon' });
  const draw = () => {
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(sheet(), (frame % ICON_COLUMNS) * 16, Math.floor(frame / ICON_COLUMNS) * 16, 16, 16, 0, 0, 32, 32);
  };
  if (sheet().complete) draw();
  else sheet().addEventListener('load', draw, { once: true });
  return canvas;
}

const statText = (e) => {
  if (e.type === 'hat') return e.price === 0 ? 'Bare head' : 'Worn by you, seen by your friend';
  if (e.type === 'rod') return `Reel power ${e.reelPower}`;
  if (e.type === 'line') return `+${Math.round(e.tensionBonus * 100)}% strength, holds ${e.maxWeight} kg`;
  const bits = Object.entries(e.rarityModifier).filter(([, m]) => m !== 1).map(([r, m]) => `${RARITY_STYLE[r].label} x${m}`);
  return bits.length ? bits.join(', ') : 'No effect';
};

/**
 * Inventory + market + gear, as an HTML overlay. At the market stall you can sell and buy; away from it
 * (the "I" key) you can look at your bag and switch between gear you own. All state comes from the economy
 * client (server or offline); this class only draws it and sends requests, and shows what the answer was.
 * Keyboard (E / I / ESC) is handled by the game scene; buttons never take focus so SPACE cannot press them.
 */
export default class ShopUI {
  /** @param {{getEconomy: () => object, onSound?: (name: string) => void}} hooks */
  constructor({ getEconomy, onSound = () => {} }) {
    this.getEconomy = getEconomy;
    this.sound = onSound;
    this.root = document.getElementById('shop');
    this.atShop = false;
    this.tab = 'fish';
    this.selected = new Set();
    this.message = '';
    this.busy = false;

    this.title = el('h2');
    this.wallet = el('span', { className: 'wallet' });
    this.tabs = el('nav');
    this.body = el('section');
    this.note = el('p', { className: 'msg' });
    const x = el('button', { type: 'button', textContent: '✕', className: 'x', title: 'Close', tabIndex: -1 }); // always in view, also on a phone
    x.addEventListener('click', () => this.close());
    this.root.replaceChildren(el('div', { className: 'panel' }, el('header', {}, this.title, this.wallet, x), this.tabs, this.body, this.note));
    this.root.hidden = true;
  }

  get isOpen() {
    return !this.root.hidden;
  }

  open({ atShop }) {
    this.atShop = atShop;
    this.tab = 'fish';
    this.selected.clear();
    this.message = atShop ? 'Sell your catch or buy better gear.' : 'Your bag and gear. Visit the market stall to sell or buy.';
    this.root.hidden = false;
    this.refresh();
  }

  close() {
    this.root.hidden = true;
  }

  refresh() {
    if (!this.isOpen) return;
    const state = this.getEconomy().state;
    if (!state) return;
    for (const id of [...this.selected]) if (!state.items.some((i) => i.id === id)) this.selected.delete(id);

    this.title.textContent = this.atShop ? 'Market' : 'Inventory';
    this.wallet.textContent = `${state.coin} coins`;
    this.tabs.replaceChildren(
      this.button(`🐟 Fish (${state.items.length}/${state.capacity})`, () => this.setTab('fish'), this.tab === 'fish' ? 'tab on' : 'tab'),
      this.button('🎣 Gear', () => this.setTab('gear'), this.tab === 'gear' ? 'tab on' : 'tab'),
      this.button(`📖 FishDex ${dexCount(state.dex)}/${speciesData.length}`, () => this.setTab('dex'), this.tab === 'dex' ? 'tab on' : 'tab'),
      ...(state.social ? [this.button('🏆 Memories', () => this.setTab('memories'), this.tab === 'memories' ? 'tab on' : 'tab')] : []),
      this.button('✕', () => this.close(), 'tab close'),
    );
    this.body.replaceChildren(this.tab === 'fish' ? this.fishTab(state) : this.tab === 'gear' ? this.gearTab(state) : this.tab === 'memories' && state.social ? this.memoriesTab(state.social) : this.dexTab(state));
    this.note.textContent = this.message;
  }

  setTab(tab) {
    this.sound('click');
    this.tab = tab;
    this.refresh();
  }

  // --- fish ---

  fishTab(state) {
    const total = (items) => items.reduce((s, i) => s + i.price, 0);
    const chosen = state.items.filter((i) => this.selected.has(i.id));
    if (state.items.length === 0) return el('p', { className: 'muted' }, 'Your bag is empty. Go catch something!');

    const rows = state.items.map((item) => {
      const sp = SPECIES.get(item.speciesId);
      const row = el('div', { className: this.selected.has(item.id) ? 'row sel' : 'row' });
      row.append(
        fishIcon(sp.icon),
        el('span', { className: 'name' }, sp.name, el('small', { style: `color:${RARITY_STYLE[sp.rarity].color}` }, ` ${RARITY_STYLE[sp.rarity].label}`)),
        el('span', { className: 'weight' }, formatWeight(item.weight)),
        el('span', { className: 'price' }, `${item.price}c`),
      );
      if (this.atShop) {
        row.onclick = () => {
          if (this.selected.has(item.id)) this.selected.delete(item.id);
          else this.selected.add(item.id);
          this.refresh();
        };
      }
      return row;
    });
    const actions = this.atShop
      ? el(
        'div', { className: 'actions' },
        this.button(`Sell selected (${chosen.length}) +${total(chosen)}c`, () => this.sell([...this.selected]), 'primary', chosen.length === 0),
        this.button(`Sell all +${total(state.items)}c`, () => this.act(() => this.getEconomy().sellAll()), 'primary'),
      )
      : el('p', { className: 'muted' }, 'Walk to the market stall (marked on the map) to sell.');
    return el('div', {}, el('div', { className: 'list' }, ...rows), actions);
  }

  async sell(ids) {
    await this.act(() => this.getEconomy().sell(ids));
    this.selected.clear();
    this.refresh();
  }

  // --- FishDex ---

  /** Every species, in table order: discovered ones show their record, the rest are silhouettes. */
  /** Friendship level, titles you can wear, and the memory board of what has happened so far. */
  memoriesTab(social) {
    const f = social.friendship;
    const root = el('div', {});
    root.append(el('h3', {}, `Friendship: ${f.name} (level ${f.level})`));
    const pct = f.next ? Math.min(100, Math.round((f.points / f.next.at) * 100)) : 100;
    root.append(el('div', { className: 'friendbar' }, el('i', { style: `width:${pct}%` })));
    root.append(el('p', { className: 'muted' }, f.next ? `${f.points} / ${f.next.at} points to ${f.next.name}. Fish together, rescue, beat bosses and open chests to grow it; trolling never takes it away.` : `${f.points} points: the highest level!`));

    root.append(el('h3', {}, 'Titles'));
    const list = el('div', { className: 'titles' });
    for (const t of social.titles) {
      const shown = social.active === t.id;
      const row = el('div', { className: t.earned ? 'row title earned' : 'row title' }, el('span', { className: 'name' }, t.earned ? t.name : '???', el('small', {}, ` ${t.text}`)));
      if (t.earned) row.append(this.button(shown ? 'Shown' : 'Show', () => this.pickTitle(shown ? null : t.id), shown ? 'tab on' : 'tab'));
      list.append(row);
    }
    root.append(list);

    root.append(el('h3', {}, 'Memory board'));
    const board = el('div', { className: 'memories' });
    for (const m of social.memories) {
      const v = social.stats[m.stat];
      const text = v === undefined ? '-' : m.kind === 'date' ? new Date(v).toLocaleDateString() : m.kind === 'kg' ? `${v.toFixed(2)} kg${social.stats[m.species] ? ` (${social.stats[m.species]})` : ''}` : String(v);
      board.append(el('div', { className: 'row' }, el('span', { className: 'name' }, m.label), el('span', { className: 'weight' }, text)));
    }
    root.append(board);
    return root;
  }

  async pickTitle(id) {
    const eco = this.getEconomy();
    if (!eco.setTitle || this.busy) return;
    this.busy = true;
    try {
      const res = await eco.setTitle(id);
      this.message = res.ok ? (id ? 'Title changed.' : 'Title hidden.') : 'You have not earned that title yet.';
    } catch {
      this.message = MESSAGES.NO_CONNECTION;
    }
    this.busy = false;
    this.refresh();
  }

  dexTab(state) {
    const dex = state.dex ?? {};
    const root = el('div', {}, el('p', { className: 'muted' }, `Discovered ${dexCount(dex)} of ${speciesData.length} species. Records are kept even after you sell the fish.`));
    for (const [region, title] of REGIONS) {
      const group = speciesData.filter((f) => (f.region ?? 'lake') === region);
      if (group.length === 0) continue;
      const found = group.filter((f) => dex[f.id]).length;
      root.append(el('h3', {}, `${title}  ${found}/${group.length}`));
      const grid = el('div', { className: 'dex' });
      for (const sp of group) {
        const entry = dex[sp.id];
        const icon = fishIcon(sp.icon);
        if (!entry) icon.classList.add('locked');
        const style = RARITY_STYLE[sp.rarity];
        grid.append(el(
          'div', { className: entry ? 'card dexcard' : 'card dexcard locked' },
          icon,
          el('b', {}, entry ? sp.name : '???'),
          el('small', { style: `color:${style.color}` }, `${style.label}${sp.boss ? ' BOSS' : ''}`),
          el('small', {}, entry ? `Caught ${entry.count}` : 'Not caught yet'),
          el('small', {}, entry ? `Best ${formatWeight(entry.biggest)}` : ' '),
        ));
      }
      root.append(grid);
    }
    return root;
  }

  // --- gear ---

  gearTab(state) {
    const root = el('div', { className: 'gear' });
    for (const [type, label] of GROUPS) {
      root.append(el('h3', {}, label));
      const cards = equipmentData.filter((e) => e.type === type).sort((a, b) => a.price - b.price).map((e) => {
        const owned = state.owned.includes(e.id) || e.price === 0;
        const equipped = (state.equipped[type] ?? (type === 'hat' ? 'hat_none' : null)) === e.id;
        const card = el('div', { className: equipped ? 'card on' : 'card' }, el('b', {}, e.name), el('small', {}, statText(e)));
        if (equipped) card.append(this.button('Equipped', () => {}, 'secondary', true));
        else if (owned) card.append(this.button('Equip', () => this.act(() => this.getEconomy().equip(e.id)), 'secondary'));
        else card.append(this.button(`Buy ${e.price}c`, () => this.act(() => this.getEconomy().buy(e.id)), 'primary', !this.atShop || state.coin < e.price));
        return card;
      });
      root.append(el('div', { className: 'cards' }, ...cards));
    }
    return root;
  }

  // --- plumbing ---

  /** Run a trade, then say what happened. Buttons are locked while a request is in flight (no double-clicks). */
  async act(run) {
    if (this.busy) return;
    this.busy = true;
    try {
      const res = await run();
      this.sound(res.ok ? (res.earned !== undefined ? 'sell' : res.price !== undefined ? 'buy' : 'equip') : 'error');
      if (res.ok) {
        if (res.earned !== undefined) this.message = `Sold ${res.sold.length} fish for ${res.earned} coins.`;
        else if (res.price !== undefined) this.message = `Bought for ${res.price} coins.`;
        else this.message = 'Equipped.';
      } else {
        this.message = MESSAGES[res.error] ?? 'That did not work.';
      }
    } finally {
      this.busy = false;
      this.refresh();
    }
  }

  button(text, onclick, className = '', disabled = false) {
    const b = el('button', { textContent: text, className, disabled, tabIndex: -1 });
    b.onmousedown = (e) => e.preventDefault(); // never take keyboard focus: SPACE/ENTER must not "press" it
    b.onclick = onclick;
    return b;
  }
}
