import Phaser from 'phaser';
import { io } from 'socket.io-client';
import { loadProfile, saveProfile, tabId } from './profile.js';

const SESSION_KEY = 'ft_session';
const REQUEST_TIMEOUT_MS = 5000;
const FIRST_CONNECT_TIMEOUT_MS = 3000;

/**
 * Thin client over Socket.IO. Keeps the room snapshot and the reconnect token.
 * Events: 'room' (view | null), 'remote' (snapshot), 'correct' ({x,y}), 'status' (online: boolean),
 * 'fishing' (own session result), 'fishing-state' (anyone's rod/bobber), 'fishing-rare' (rare catch by others),
 * 'inventory' (coins, bag, gear: the server's authoritative copy, pushed after every change).
 */
export default class NetworkSystem extends Phaser.Events.EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this.online = false;
    this.room = null;
    this.pid = null;
    this.token = null;
    // Last known rod/bobber state per player. Snapshots can arrive before the game scene exists
    // (e.g. right after joining), so the scene reads this when it builds the remote players.
    this.fishingStates = new Map();
    this.world = null; // {seed, offset}: the sky's seed and how far the server's clock is ahead of ours
    this.state = null; // inventory snapshot {coin, capacity, items, owned, equipped, dex}
    this.notice = null; // one-off message for the lobby (e.g. the room we were in is gone)
  }

  get me() {
    return this.room?.players.find((p) => p.pid === this.pid) ?? null;
  }

  /** Resolves once the first connection attempt settles (connected + rejoin tried, failed, or timed out). */
  connect() {
    return new Promise((resolve) => {
      const settle = () => resolve();
      setTimeout(settle, FIRST_CONNECT_TIMEOUT_MS);

      this.socket = io({ transports: ['websocket'] });
      this.socket.on('connect', async () => {
        this.online = true;
        await this.hello();
        await this.rejoin();
        this.emit('status', true);
        settle();
      });
      this.socket.on('disconnect', () => {
        this.online = false;
        this.emit('status', false);
      });
      this.socket.on('connect_error', settle);
      this.socket.on('room:state', (view) => this.setRoom(view));
      this.socket.on('player:state', (s) => this.emit('remote', s));
      this.socket.on('player:correct', (c) => this.emit('correct', c));
      this.socket.on('fishing:event', (e) => this.emit('fishing', e)); // bite / miss / fail / hooked: ours only
      this.socket.on('inv:state', (st) => this.setState(st));
      this.socket.on('emote', (e) => this.emit('emote', e));
      this.socket.on('chat', (m) => this.emit('chat', m));
      for (const event of ['seagull:attack', 'seagull:result', 'chest:spawn', 'chest:gone', 'chest:opened']) this.socket.on(event, (e) => this.emit(event.replace(':', '-'), e));
      for (const event of ['rush:spot', 'rush:claimed', 'rush:gone', 'boss:spot', 'boss:gone', 'boss:hooked', 'boss:fight', 'boss:state', 'boss:roles', 'boss:result']) this.socket.on(event, (e) => this.emit(event.replace(':', '-'), e));
      for (const event of ['social:toast', 'challenge:start', 'challenge:score', 'challenge:end']) this.socket.on(event, (e) => this.emit(event.replace(':', '-'), e));
      for (const event of ['boat:tilt', 'boat:capsized']) this.socket.on(event, (e) => this.emit(event.replace(':', '-'), e));
      for (const event of ['combat:throw', 'duel:offer', 'duel:offered', 'duel:declined', 'duel:start', 'duel:hit', 'duel:end']) this.socket.on(event, (e) => this.emit(event.replace(':', '-'), e));
      this.socket.on('steal:open', (e) => this.emit('steal-open', e)); // the other player just landed a fish you may try to steal
      this.socket.on('steal:start', (e) => this.emit('steal-start', e));
      this.socket.on('steal:result', (e) => this.emit('steal-result', e));
      this.socket.on('rescue:event', (e) => this.emit('rescue', e)); // a lifebuoy was thrown / someone was pulled out
      this.socket.on('combat:hit', (e) => this.emit('combat', e)); // a swing (hit or miss) on our map
      this.socket.on('fishing:rare', (r) => this.emit('fishing-rare', r)); // someone else landed a rare fish
      this.socket.on('fishing:state', (s) => {
        if (s.state === 'idle') this.fishingStates.delete(s.pid);
        else this.fishingStates.set(s.pid, s);
        this.emit('fishing-state', s); // rod + bobber of everyone in the room
      });
    });
  }

  async createRoom(name) {
    return this.enter(await this.request('room:create', { name }));
  }

  async joinRoom(code, name) {
    return this.enter(await this.request('room:join', { code, name }));
  }

  setReady(ready) {
    this.socket.emit('room:ready', ready);
  }

  async leave() {
    try {
      await this.request('room:leave');
    } catch {
      /* offline: just drop local state */
    }
    this.clearSession();
    this.setRoom(null);
  }

  /** The server's clock, which everyone's time of day and weather is computed from. */
  worldNow() {
    return Date.now() + (this.world?.offset ?? 0);
  }

  /** Sail through a portal (the pier's boat, the harbour). The room state that follows carries our new map. */
  travel(portalId) {
    return this.trade('map:travel', { portalId });
  }

  /** A cartoon attack on the other player: 'slap' | 'push' | 'bonk'. Resolves {ok, hit} or {ok: false, error}. */
  attack(kind) {
    if (!this.socket?.connected) return Promise.resolve({ ok: false, error: 'NO_CONNECTION' });
    return this.request('combat:act', { kind });
  }

  /** During the co-op boss fight: is SPACE held? What it does depends on our role. */
  bossInput(held) {
    this.socket?.volatile.emit('boss:input', { held });
  }

  /** Throw a fish or piece of junk from the bag (not used up). */
  throwItem() {
    if (!this.socket?.connected) return Promise.resolve({ ok: false, error: 'NO_CONNECTION' });
    return this.request('combat:throw');
  }

  duelChallenge() {
    if (!this.socket?.connected) return Promise.resolve({ ok: false, error: 'NO_CONNECTION' });
    return this.request('duel:challenge');
  }

  duelRespond(accept) {
    if (!this.socket?.connected) return Promise.resolve({ ok: false, error: 'NO_CONNECTION' });
    return this.request('duel:respond', { accept });
  }

  /** A duel move: 'punch' | 'kick' | 'push' | 'dodge'. */
  duelAct(kind) {
    if (!this.socket?.connected) return Promise.resolve({ ok: false, error: 'NO_CONNECTION' });
    return this.request('duel:act', { kind });
  }

  /** Choose the title shown next to our name (an earned one), or none with null. */
  setTitle(id) {
    if (!this.socket?.connected) return Promise.resolve({ ok: false, error: 'NO_CONNECTION' });
    return this.request('social:title', { id });
  }

  /** Tell the server a photo was taken (counts for the memory board). */
  photoTaken() {
    if (!this.socket?.connected) return Promise.resolve({ ok: false, error: 'NO_CONNECTION' });
    return this.request('social:photo');
  }

  /** Chase off the seagull that is after our fish. */
  shooGull() {
    if (!this.socket?.connected) return Promise.resolve({ ok: false, error: 'NO_CONNECTION' });
    return this.request('seagull:shoo');
  }

  /** Press "open" on the treasure chest; it opens when both players press within a moment. */
  openChest() {
    if (!this.socket?.connected) return Promise.resolve({ ok: false, error: 'NO_CONNECTION' });
    return this.request('chest:open');
  }

  /** Try to steal the fish the player next to us just landed. Resolves {ok} or {ok: false, error, ms?}. */
  stealStart() {
    if (!this.socket?.connected) return Promise.resolve({ ok: false, error: 'NO_CONNECTION' });
    return this.request('steal:start');
  }

  /** Stop the needle in the duel. */
  stealPress() {
    if (!this.socket?.connected) return Promise.resolve({ ok: false, error: 'NO_CONNECTION' });
    return this.request('steal:press');
  }

  /** Throw a lifebuoy to a swimmer nearby. */
  rescueThrow() {
    if (!this.socket?.connected) return Promise.resolve({ ok: false, error: 'NO_CONNECTION' });
    return this.request('rescue:throw');
  }

  /** Grab the lifebuoy that was thrown to us. */
  rescueGrab() {
    if (!this.socket?.connected) return Promise.resolve({ ok: false, error: 'NO_CONNECTION' });
    return this.request('rescue:grab');
  }

  /** Friendly mode: nobody can hit you (and you cannot hit). */
  setFriendly(friendly) {
    if (!this.socket?.connected) return Promise.resolve({ ok: false, error: 'NO_CONNECTION' });
    return this.request('combat:mode', { friendly });
  }

  /** Shared boat: 'board' the other player's boat, 'leave' it (passenger), 'switch' seats. Resolves {ok, ...} or {ok: false, error}. */
  boat(action) {
    if (!this.socket?.connected) return Promise.resolve({ ok: false, error: 'NO_CONNECTION' });
    return this.request(`boat:${action}`);
  }

  /** Send a chat message to the room. Resolves {ok} or {ok: false, error}; the message itself comes back as a 'chat' event. */
  chat(text) {
    if (!this.socket?.connected) return Promise.resolve({ ok: false, error: 'NO_CONNECTION' });
    return this.request('chat', { text });
  }

  emote(id) {
    this.socket?.volatile.emit('emote', { id });
  }

  sendState(state) {
    this.socket.volatile.emit('player:state', state);
  }

  /** Identify ourselves: the remembered profile (coins, fish, gear) or a fresh one if the server issues it. */
  async hello() {
    try {
      const saved = loadProfile();
      let name = '';
      try {
        name = localStorage.getItem('ft_nick') ?? '';
      } catch { /* ignore */ }
      const res = await this.request('profile:hello', { ...(saved ?? {}), tab: tabId(), name });
      if (res.ok) {
        if (res.profile.token) saveProfile(res.profile);
        this.setState(res.state);
        this.world = res.world ? { seed: res.world.seed, offset: res.world.now - Date.now(), lucky: res.world.lucky ?? null } : null;
      }
    } catch {
      /* offline or slow: rooms still work with a guest profile, and the state arrives on the next change */
    }
  }

  setState(state) {
    this.state = state;
    this.emit('inventory', state);
  }

  // Trading. The server answers with the new state (and also pushes it), or an error code.
  sell(ids) {
    return this.trade('inv:sell', { ids });
  }

  sellAll() {
    return this.trade('inv:sellAll');
  }

  buy(id) {
    return this.trade('shop:buy', { id });
  }

  equip(id) {
    return this.trade('shop:equip', { id });
  }

  async trade(event, payload) {
    try {
      const res = await this.request(event, payload);
      if (res.state) this.setState(res.state);
      return res;
    } catch {
      return { ok: false, error: 'NO_CONNECTION' };
    }
  }

  /** Called on every (re)connect: reclaim our slot if we had one. */
  async rejoin() {
    const saved = this.loadSession();
    if (!saved) return;
    try {
      const res = await this.request('room:rejoin', { code: saved.code, token: saved.token });
      if (res.ok) this.enter(res);
      else {
        this.clearSession();
        this.notice = 'Your room is no longer available.';
        this.setRoom(null);
      }
    } catch {
      /* server unreachable; keep the session for the next reconnect */
    }
  }

  enter(res) {
    if (!res.ok) return res;
    this.pid = res.pid;
    this.token = res.token;
    this.saveSession({ code: res.room.code, token: res.token });
    this.setRoom(res.room);
    return res;
  }

  setRoom(view) {
    if (!view) this.fishingStates.clear();
    if (view) view.receivedAt = performance.now(); // lets the scene count down the boss spot's remaining time
    this.room = view;
    this.emit('room', view);
  }

  request(event, payload) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${event} timed out`)), REQUEST_TIMEOUT_MS);
      this.socket.emit(event, payload, (res) => {
        clearTimeout(timer);
        resolve(res);
      });
    });
  }

  // sessionStorage: survives a reload of this tab, but two tabs on one machine stay two players.
  loadSession() {
    try {
      return JSON.parse(sessionStorage.getItem(SESSION_KEY));
    } catch {
      return null;
    }
  }

  saveSession(s) {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
    } catch { /* private mode */ }
  }

  clearSession() {
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch { /* private mode */ }
  }
}
