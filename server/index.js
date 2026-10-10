import http from 'node:http';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import compression from 'compression';
import { Server } from 'socket.io';
import { RoomManager, sanitizeName } from './rooms.js';
import { openSqlStore } from './sqlStore.js';
import FishingSessions from '../src/systems/FishingSessions.js';
import Economy, { DEFAULT_GEAR, DEFAULT_OWNED } from '../src/systems/Economy.js';
import { createWorld } from '../src/systems/World.js';
import Steals from './steals.js';
import { Seagulls, Chests } from './randomEvents.js';
import BossFights from './bossFights.js';
import SocialService from './social.js';
import Challenges from './challenges.js';
import Duels from './duels.js';
import Rush from './rush.js';
import { getMap } from '../src/data/maps.js';
import { sanitizeChat } from '../src/systems/ChatRules.js';

const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const SPOTS = readJson('../src/data/spots.json');
const SPECIES = readJson('../src/data/fish.json');
const BEHAVIOURS = readJson('../src/data/behaviours.json');
const EQUIPMENT = readJson('../src/data/equipment.json');
const EMOTES = readJson('../src/data/emotes.json');
const CONDITIONS = readJson('../src/data/conditions.json');
const EVENTS = readJson('../src/data/events.json');
const TRASH = readJson('../src/data/trash.json');
const RANDOM = readJson('../src/data/randomEvents.json');
const BOSSES = readJson('../src/data/bosses.json');
const SOCIAL = readJson('../src/data/social.json');
const CHALLENGES = readJson('../src/data/challenges.json');
const DUEL = readJson('../src/data/duel.json');
const RUSH = readJson('../src/data/rush.json');
const COOP_BEHAVIOURS = readJson('../src/data/coopBehaviours.json');
const RARITY_OF = new Map(SPECIES.map((f) => [f.id, f.rarity]));
const EQUIP_BY_ID = new Map(EQUIPMENT.map((e) => [e.id, e]));
const ITEM_BY_ID = new Map([...SPECIES, ...TRASH, ...BOSSES].map((f) => [f.id, f]));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
const sameHash = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Start the game server. In production it also serves the built client from dist/.
 * @param {{port?: number, graceMs?: number, fishing?: object, now?: () => number, rng?: () => number,
 *          store?: object, dbFile?: string|null, world?: {seed?: number} | false}} opts
 *   port 0 = pick a free port; fishing = overrides for the FISHING constants (tests use short timers);
 *   world = the shared clock/weather (seed picks the sky); `false` switches weather and events off (tests).
 *   store = an Economy store (tests inject one), otherwise dbFile = SQLite file (null = in memory, nothing persisted)
 */
export async function createGameServer({
  port = 3001, graceMs = 30000, swimMs, steal: stealConfig = {}, random: randomOption = false, boss: bossOption = {}, challenge: challengeOption = {}, boat: boatOption = {}, duel: duelOption = {}, fishing: fishingConfig = {}, now = Date.now, rng = Math.random, store: givenStore = null, dbFile = null,
  world: worldOption = {},
} = {}) {
  const store = givenStore ?? (await openSqlStore({ file: dbFile }));
  // Time of day, weather and events are pure functions of (clock, seed): clients compute them from the same inputs.
  // Random events (junk, chests, seagulls, the lucky spot): off unless asked for, so tests with scripted rolls stay exact.
  const random = randomOption ? { ...RANDOM, ...(randomOption === true ? {} : randomOption) } : null;
  const luckyConfig = random && worldOption !== false
    ? { ...random.lucky, spots: SPOTS.filter((s) => s.type !== 'zone' && (s.map ?? 'lake') === 'lake').map((s) => s.id) }
    : null;
  const world = worldOption === false ? null : createWorld({ conditions: CONDITIONS, events: EVENTS, lucky: luckyConfig });
  const worldSeed = worldOption === false ? 0 : (worldOption.seed ?? Math.floor(Math.random() * 0xffffffff));
  const worldFor = (mapId) => (world ? world.state(now(), { seed: worldSeed, mapId }) : null);
  const economy = new Economy({ store, species: [...SPECIES, ...TRASH, ...BOSSES], equipment: EQUIPMENT, now, social: SOCIAL });

  const app = express();
  app.disable('x-powered-by');
  app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.rooms.size }));
  const dist = path.join(ROOT, 'dist');
  if (existsSync(dist)) {
    app.use(compression()); // the game bundle is ~1.8 MB of JavaScript; gzip brings it to ~400 KB
    app.use(express.static(dist, {
      setHeaders: (res, file) => {
        // Vite fingerprints the bundles, so they can be cached forever; the page itself must always be fresh.
        const hashed = /[\\/]assets[\\/][^\\/]+-[A-Za-z0-9_-]{8}\.(js|css)$/.test(file);
        res.setHeader('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : file.endsWith('.html') ? 'no-cache' : 'public, max-age=3600');
      },
    }));
  }
  const httpServer = http.createServer(app);
  const io = new Server(httpServer);

  // --- player profiles: a stable identity (id + secret token kept in the browser) that owns coins, fish and gear ---

  const createProfile = (name) => {
    const id = randomBytes(6).toString('hex');
    const token = randomBytes(16).toString('hex');
    store.createProfile({ id, tokenHash: sha256(token), name: sanitizeName(name), coin: 0, owned: [...DEFAULT_OWNED], equipped: { ...DEFAULT_GEAR }, createdAt: now() });
    return { profile: store.getProfile(id), token };
  };
  const authenticate = (id, token) => {
    const p = typeof id === 'string' && typeof token === 'string' ? store.getProfile(id) : null;
    return p && sameHash(p.tokenHash, sha256(token)) ? p : null;
  };
  const bound = new Map(); // profileId -> {socketId, tab}: which connection is currently playing with it

  // The server moved a player (a duel, a climb out of the water, a rescue): they snap there, and so does their picture on the other screen.
  const showAt = (p) => {
    if (p.socketId) io.to(p.socketId).emit('player:correct', { x: p.x, y: p.y });
    for (const other of rooms.neighbours(p)) io.to(other.socketId).emit('player:state', { pid: p.pid, x: p.x, y: p.y, facing: p.facing, moving: false, t: performance.now() });
  };
  const players = new Map(); // pid -> room player, so fishing events can find the room/socket/profile
  const inventoryTo = (socketId, profileId) => socketId && io.to(socketId).emit('inv:state', economy.state(profileId));

  const fishing = new FishingSessions({
    spots: SPOTS,
    species: SPECIES,
    trash: TRASH,
    extra: BOSSES,
    behaviours: { ...BEHAVIOURS, ...COOP_BEHAVIOURS },
    config: random ? { TRASH_CHANCE: random.trashChance, CHEST_CHANCE: random.chestChance, FAKE_CHANCE: random.fakeLegendaryChance, ...fishingConfig } : fishingConfig,
    now,
    rng,
    hooks: {
      // The bag is the only thing that can stop you casting: no point fighting a fish you cannot keep.
      beforeCast: (pid) => (economy.isFull(players.get(pid).profileId) ? 'INVENTORY_FULL' : null),
      gear: (pid) => economy.gear(players.get(pid).profileId),
      conditions: (_pid, mapId) => worldFor(mapId),
      forcedCatch: (pid, spotId) => bossFights.forced(players.get(pid), spotId) ?? rush.forced(players.get(pid), spotId),
      onCoopHook: (pid, session) => bossFights.hooked(players.get(pid), session),
      onCatch: (pid, c) => {
        const p = players.get(pid);
        const sp = ITEM_BY_ID.get(c.speciesId);
        if (sp?.chest) {
          chests.spawn(p); // a chest is not kept in the bag: it appears on the ground for both players to open together
          return { ok: true, item: null };
        }
        const res = economy.addCatch(p.profileId, c);
        if (res.ok) {
          if (!sp.trash) rooms.recordCatch(p, { weight: c.weight, rarity: RARITY_OF.get(c.speciesId) });
          const friend = social.friendNear(p);
          social.landed(p, { species: sp, weight: c.weight, friend });
          challenges.record(p, sp, c.weight, c.fightSec);
          if (friend && !sp.trash) social.together([friend], 'catchTogether');
          if (!seagulls.maybe(p, res.item, sp)) steals.noteCatch(p, res.item);
        }
        inventoryTo(p.socketId, p.profileId);
        return res;
      },
    },
    emit: (pid, event, payload) => {
      const p = players.get(pid);
      if (!p) return;
      if (event === 'state') {
        // Everyone who can see this player sees the rod and bobber: others on the same map.
        for (const other of rooms.neighbours(p)) io.to(other.socketId).emit('fishing:state', payload);
        if (p.socketId) io.to(p.socketId).emit('fishing:state', payload);
      }
      else if (event === 'rare') {
        // Announce to everyone except the catcher (they get their own catch card). One finish() = one event.
        io.to(p.room.code).except(p.socketId ?? '').emit('fishing:rare', { pid, name: p.name, ...payload });
      } else if (p.socketId) io.to(p.socketId).emit('fishing:event', { event, ...payload }); // result: caster only
    },
  });

  const rooms = new RoomManager({
    graceMs,
    onProjectileHit: ({ shot, thrower, target, x, y, stunMs, fell }) => {
      fishing.cancel(target.pid);
      if (target.socketId) io.to(target.socketId).emit('player:correct', { x, y });
      const event = { kind: 'throw', from: shot.pid, to: target.pid, x, y, stunMs, fell: Boolean(fell), shot: shot.id };
      for (const p of [thrower, target]) if (p?.socketId) io.to(p.socketId).emit('combat:hit', event);
      if (fell) social.stat(target, 'fellInWater');
    },
    swimMs,
    capsizeMs: boatOption.capsizeMs,
    onTilt: (driver, tilt) => {
      for (const p of [driver, driver.boatWith]) if (p?.socketId) io.to(p.socketId).emit('boat:tilt', { tilt });
    },
    onCapsize: (crew, by = null) => {
      for (const p of crew) {
        fishing.cancel(p.pid);
        if (by && by.socketId) io.to(by.socketId).emit('boat:capsized', { pids: crew.map((c) => c.pid), by: by.pid });
        if (p.socketId) io.to(p.socketId).emit('boat:capsized', { pids: crew.map((c) => c.pid), by: by?.pid ?? null });
        social.stat(p, 'capsized');
      }
      for (const p of crew) if (p.socketId) io.to(p.socketId).emit('boat:tilt', { tilt: 0 });
    },
    onMoved: (p) => showAt(p),
    hatOf: (p) => {
      if (p.hat === undefined) p.hat = (p.profileId && store.getProfile(p.profileId)?.equipped.hat) || null;
      return p.hat === 'hat_none' ? null : p.hat;
    },
    now, // one clock for rooms and fishing, so tests (and the world) agree on what time it is
    onChange: (room) => {
      io.to(room.code).emit('room:state', rooms.view(room));
      bossFights.ensureScheduled(room);
      challenges.ensureScheduled(room);
      rush.ensureScheduled(room);
    },
    onRemoved: (player) => {
      steals.cancelFor(player);
      duels.cancelFor(player);
      challenges.cancelFor(player);
      bossFights.cancelFor(player);
      rush.cancelFor(player);
      seagulls.cancelFor(player);
      fishing.cancel(player.pid);
      players.delete(player.pid);
      if (player.socketId) io.sockets.sockets.get(player.socketId)?.leave(player.room.code);
    },
  });

  const social = new SocialService({
    economy,
    store,
    config: SOCIAL,
    now,
    emit: (p, event, payload) => p.socketId && io.to(p.socketId).emit(event, payload),
    changed: (p) => inventoryTo(p.socketId, p.profileId),
    roomChanged: (p) => rooms.onChange(p.room),
  });

  const duels = new Duels({
    rooms,
    economy,
    social,
    now,
    config: { ...DUEL, ...duelOption },
    emit: (p, event, payload) => {
      if (event === 'duel:moved') {
        showAt(p);
        return;
      }
      if (p.socketId) io.to(p.socketId).emit(event, payload);
    },
    bagChanged: (p) => inventoryTo(p.socketId, p.profileId),
  });

  const challenges = new Challenges({
    rooms,
    economy,
    config: { ...CHALLENGES, ...challengeOption },
    now,
    rng,
    social,
    schedule: Boolean(random),
    emitRoom: (room, event, payload) => io.to(room.code).emit(event, payload),
    bagChanged: (p) => inventoryTo(p.socketId, p.profileId),
  });

  const steals = new Steals({
    social,
    rooms,
    economy,
    species: SPECIES,
    now,
    config: stealConfig,
    emit: (p, event, payload) => p.socketId && io.to(p.socketId).emit(event, payload),
    bagChanged: (p) => inventoryTo(p.socketId, p.profileId),
  });

  const seagulls = new Seagulls({
    social,
    economy, now, rng, config: random ?? {}, emit: (p, event, payload) => p.socketId && io.to(p.socketId).emit(event, payload), bagChanged: (p) => inventoryTo(p.socketId, p.profileId),
  });
  const chests = new Chests({
    social,
    economy, now, rng, config: random ?? { chest: RANDOM.chest }, emitRoom: (room, event, payload) => io.to(room.code).emit(event, payload), bagChanged: (p) => inventoryTo(p.socketId, p.profileId),
  });

  const bossFights = new BossFights({
    social,
    rooms,
    fishing,
    economy,
    bosses: BOSSES,
    behaviours: { ...BEHAVIOURS, ...COOP_BEHAVIOURS },
    spots: SPOTS.filter((s) => s.type !== 'zone' && (s.map ?? 'lake') === 'lake').map((s) => s.id),
    now,
    rng,
    config: bossOption,
    schedule: Boolean(random), // bosses turn up by themselves only with the random events on
    autoTick: bossOption.autoTick !== false,
    emit: (p, event, payload) => p.socketId && io.to(p.socketId).emit(event, payload),
    emitRoom: (room, event, payload) => io.to(room.code).emit(event, payload),
    bagChanged: (p) => inventoryTo(p.socketId, p.profileId),
  });

  const rush = new Rush({
    rooms,
    social,
    species: SPECIES,
    spots: SPOTS.filter((s) => s.type !== 'zone' && (s.map ?? 'lake') === 'lake').map((s) => s.id),
    config: { ...RUSH, ...(randomOption && typeof randomOption === 'object' ? randomOption.rush : {}) },
    now,
    rng,
    schedule: Boolean(random),
    emitRoom: (room, event, payload) => io.to(room.code).emit(event, payload),
  });

  const boatTimer = setInterval(() => { rooms.tickBoats(); rooms.tickProjectiles(); }, 50); // shared boats lean and flip over time, not only when a message arrives
  boatTimer.unref?.();

  const atShop = (p) => {
    const shop = p && getMap(p.mapId).shop;
    return Boolean(shop) && p.room.phase === 'playing' && Math.hypot(p.x - shop.talkX, p.y - shop.talkY) <= shop.radius + shop.tolerance;
  };

  io.on('connection', (socket) => {
    /** @type {ReturnType<RoomManager['create']>['player'] | null} */
    let player = null;
    let profileId = null;

    const attach = (p) => {
      player = p;
      players.set(p.pid, p);
      p.socketId = socket.id;
      social.refreshTitle(p);
      socket.join(p.room.code);
      // Late joiner / returning player: show lines that are already out, not only future changes.
      for (const other of p.room.players) {
        const f = other.pid === p.pid ? null : fishing.get(other.pid);
        if (f) socket.emit('fishing:state', { pid: other.pid, state: f.state, bobber: f.bobber, facing: f.facing });
      }
    };
    const reply = (ack, payload) => typeof ack === 'function' && ack(payload);
    const session = (p) => ({ ok: true, pid: p.pid, token: p.token, room: rooms.view(p.room) });

    const bind = (id, tab) => {
      profileId = id;
      bound.set(id, { socketId: socket.id, tab });
    };

    // Clients say hello with the profile they remember. No/unknown/wrong token = a new profile is issued.
    socket.on('profile:hello', (msg, ack) => {
      const tab = String(msg?.tab ?? '').slice(0, 40);
      let profile = authenticate(msg?.id, msg?.token);
      let fresh = false;
      if (profile) {
        const other = bound.get(profile.id);
        const live = other && other.socketId !== socket.id && io.sockets.sockets.has(other.socketId);
        if (live && other.tab !== tab) {
          // Another tab of the same browser is playing with this profile: this tab gets its own.
          profile = null;
          fresh = true;
        } else if (live) {
          io.sockets.sockets.get(other.socketId)?.disconnect(true); // the same tab reloaded; its old socket is stale
        }
      }
      let token;
      if (!profile) ({ profile, token } = createProfile(msg?.name));
      bind(profile.id, tab);
      reply(ack, {
        ok: true,
        profile: { id: profile.id, ...(token ? { token } : {}), fresh },
        state: economy.state(profile.id),
        world: world ? { seed: worldSeed, now: now(), lucky: luckyConfig } : null, // clients keep the difference to their own clock
      });
    });

    // Rooms need a profile; anyone who skipped the hello (old clients, tests) gets a guest one.
    const ensureProfile = (name) => {
      if (!profileId) bind(createProfile(name).profile.id, '');
      return profileId;
    };

    socket.on('room:create', (msg, ack) => {
      if (player) return reply(ack, { ok: false, error: 'ALREADY_IN_ROOM' });
      const { player: p } = rooms.create(msg?.name, ensureProfile(msg?.name));
      attach(p);
      reply(ack, session(p));
    });

    socket.on('room:join', (msg, ack) => {
      if (player) return reply(ack, { ok: false, error: 'ALREADY_IN_ROOM' });
      const res = rooms.join(msg?.code, msg?.name, ensureProfile(msg?.name));
      if (res.error) return reply(ack, { ok: false, error: res.error });
      attach(res.player);
      reply(ack, session(res.player));
      io.to(res.room.code).emit('room:state', rooms.view(res.room));
    });

    socket.on('room:rejoin', (msg, ack) => {
      if (player) return reply(ack, { ok: false, error: 'ALREADY_IN_ROOM' });
      const res = rooms.rejoin(msg?.code, msg?.token);
      if (res.error) return reply(ack, { ok: false, error: res.error });
      // A stale socket may still hold this slot (e.g. page reload before the old one timed out).
      if (res.player.socketId && res.player.socketId !== socket.id) {
        io.sockets.sockets.get(res.player.socketId)?.disconnect(true);
      }
      attach(res.player);
      if (!profileId) bind(res.player.profileId, ''); // rejoining restores the profile the slot belongs to
      reply(ack, session(res.player));
    });

    socket.on('room:ready', (ready) => {
      if (player) rooms.setReady(player, ready);
    });

    socket.on('room:leave', (_msg, ack) => {
      if (player) {
        const p = player;
        player = null;
        fishing.cancel(p.pid);
        socket.leave(p.room.code);
        rooms.leave(p);
      }
      reply(ack, { ok: true });
    });

    // Emotes: shown to the other player. The sender draws their own immediately, so they are not echoed back.
    socket.on('emote', (msg) => {
      const id = msg?.id;
      if (!player || player.room.phase !== 'playing' || !Number.isInteger(id) || id < 0 || id >= EMOTES.length) return;
      if (rooms.tryEmote(player)) for (const other of rooms.neighbours(player)) io.to(other.socketId).emit('emote', { pid: player.pid, id });
    });

    // Chat: text is cleaned and rate limited here, then goes to everyone in the room (the sender too, so all logs match).
    socket.on('chat', (msg, ack) => {
      if (!player || player.room.phase !== 'playing') return reply(ack, { ok: false, error: 'NOT_PLAYING' });
      const text = sanitizeChat(msg?.text);
      if (!text) return reply(ack, { ok: false, error: 'EMPTY' });
      if (!rooms.tryChat(player)) return reply(ack, { ok: false, error: 'TOO_FAST' });
      io.to(player.room.code).emit('chat', { pid: player.pid, name: player.name, slot: player.slot, text });
      reply(ack, { ok: true });
    });

    // --- inventory, shop, gear ---

    const economyCall = (ack, { needShop = false, needIdle = false }, run) => {
      if (!profileId) return reply(ack, { ok: false, error: 'NO_PROFILE' });
      if (needShop && !atShop(player)) return reply(ack, { ok: false, error: 'NOT_AT_SHOP' });
      if (needIdle && player && fishing.get(player.pid)) return reply(ack, { ok: false, error: 'BUSY' }); // gear is locked in mid-fight
      let res;
      try {
        res = run();
      } catch (err) {
        console.error('[economy]', err);
        return reply(ack, { ok: false, error: 'SERVER_ERROR' });
      }
      reply(ack, { ...res, state: economy.state(profileId) });
      if (res.ok) socket.emit('inv:state', economy.state(profileId));
    };

    socket.on('inv:get', (_msg, ack) => economyCall(ack, {}, () => ({ ok: true })));
    socket.on('inv:sell', (msg, ack) => economyCall(ack, { needShop: true }, () => economy.sell(profileId, msg?.ids)));
    socket.on('inv:sellAll', (_msg, ack) => economyCall(ack, { needShop: true }, () => economy.sellAll(profileId)));
    socket.on('shop:buy', (msg, ack) => economyCall(ack, { needShop: true }, () => economy.buy(profileId, msg?.id)));
    socket.on('shop:equip', (msg, ack) => economyCall(ack, { needIdle: true }, () => {
      const res = economy.equip(profileId, msg?.id);
      if (res.ok && EQUIP_BY_ID.get(msg.id)?.type === 'hat') {
        player.hat = msg.id;
        rooms.onChange(player.room); // your friend sees the new hat
      }
      return res;
    }));

    // --- fishing ---

    socket.on('fishing:cast', (msg, ack) => {
      if (!player || player.room.phase !== 'playing' || !player.connected) return reply(ack, { ok: false, error: 'NOT_PLAYING' });
      if (player.swimming) return reply(ack, { ok: false, error: 'SWIMMING' });
      if (now() < player.stunnedUntil) return reply(ack, { ok: false, error: 'STUNNED' });
      if (player.seat && !rooms.boatStill(player)) return reply(ack, { ok: false, error: 'BOAT_MOVING' }); // a shared boat must be stopped
      reply(ack, fishing.cast(player.pid, { spotId: msg?.spotId, power: msg?.power, facing: msg?.facing, x: player.x, y: player.y, mapId: player.mapId }));
    });

    // Sailing between maps: stand at a portal (the pier's boat, the harbour) and ask. Not while a line is out.
    socket.on('map:travel', (msg, ack) => {
      if (!player || !player.connected) return reply(ack, { ok: false, error: 'NOT_PLAYING' });
      if (player.swimming) return reply(ack, { ok: false, error: 'SWIMMING' });
      if (fishing.get(player.pid) || (player.seat === 'driver' && fishing.get(player.boatWith.pid))) return reply(ack, { ok: false, error: 'BUSY' });
      reply(ack, rooms.travel(player, msg?.portalId));
    });

    socket.on('fishing:hook', (msg, ack) => {
      reply(ack, player ? fishing.hook(player.pid, msg?.id) : { ok: false, error: 'NO_SESSION' });
    });

    socket.on('fishing:finish', (msg, ack) => {
      reply(ack, player ? fishing.finish(player.pid, msg?.id, msg?.toggles) : { ok: false, error: 'NO_SESSION' });
    });

    socket.on('fishing:cancel', (_msg, ack) => {
      if (player) fishing.cancel(player.pid);
      reply(ack, { ok: true });
    });

    // Cartoon fighting (on foot). Everyone on the map sees the swing; a hit also cancels the victim's line.
    socket.on('combat:act', (msg, ack) => {
      if (!player || !player.connected) return reply(ack, { ok: false, error: 'NOT_PLAYING' });
      if (fishing.get(player.pid)) return reply(ack, { ok: false, error: 'BUSY' });
      const res = rooms.attack(player, msg?.kind);
      if (!res.ok) return reply(ack, res);
      const event = { kind: msg.kind, from: player.pid, to: res.hit ? res.target.pid : null, x: res.hit ? res.x : null, y: res.hit ? res.y : null, stunMs: res.hit ? res.stunMs : 0, fell: Boolean(res.fell) };
      if (res.hit) {
        fishing.cancel(res.target.pid);
        if (res.target.socketId) io.to(res.target.socketId).emit('player:correct', { x: res.x, y: res.y });
      }
      if (res.hit && (msg.kind === 'push' || msg.kind === 'big')) social.stat(player, 'pushedFriend');
      if (res.fell) social.stat(res.target, 'fellInWater');
      for (const p of [player, ...rooms.neighbours(player)]) if (p.socketId) io.to(p.socketId).emit('combat:hit', event);
      reply(ack, { ok: true, hit: res.hit });
    });

    // Duels: challenge your friend, they accept or decline; then punch / kick / shove / dodge until one runs out of health.
    const duelCall = (ack, run) => {
      if (!player || !player.connected) return reply(ack, { ok: false, error: 'NOT_PLAYING' });
      if (fishing.get(player.pid)) return reply(ack, { ok: false, error: 'BUSY' });
      reply(ack, run());
    };
    socket.on('duel:challenge', (_msg, ack) => duelCall(ack, () => duels.challenge(player)));
    socket.on('duel:respond', (msg, ack) => duelCall(ack, () => duels.respond(player, Boolean(msg?.accept))));
    socket.on('duel:act', (msg, ack) => duelCall(ack, () => duels.act(player, msg?.kind)));

    // Throw a fish (or junk) from the bag: it is not lost, it is just thrown. Slow, so you can dodge it.
    socket.on('combat:throw', (_msg, ack) => {
      if (!player || !player.connected || !profileId) return reply(ack, { ok: false, error: 'NOT_PLAYING' });
      if (fishing.get(player.pid)) return reply(ack, { ok: false, error: 'BUSY' });
      const ammo = economy.state(profileId).items.filter((i) => ITEM_BY_ID.get(i.speciesId)?.trash || (i.weight <= 1.5 && ITEM_BY_ID.get(i.speciesId)?.rarity === 'common'));
      if (ammo.length === 0) return reply(ack, { ok: false, error: 'NO_AMMO' });
      const res = rooms.throwItem(player);
      if (!res.ok) return reply(ack, res);
      const pick = ammo[Math.floor(rng() * ammo.length)];
      const shot = { ...res.shot, from: player.pid, icon: ITEM_BY_ID.get(pick.speciesId).icon };
      for (const p of [player, ...rooms.neighbours(player)]) if (p.socketId) io.to(p.socketId).emit('combat:throw', shot);
      reply(ack, { ok: true });
    });

    // Co-op boss: the held state of SPACE during the fight (volatile: only the latest matters).
    socket.on('boss:input', (msg) => {
      if (player && player.connected) bossFights.input(player, msg?.held);
    });

    // Fish stealing: grab the fish your friend just landed (both must be in FIGHT mode), then a timing duel decides.
    socket.on('steal:start', (_msg, ack) => {
      if (!player || !player.connected) return reply(ack, { ok: false, error: 'NOT_PLAYING' });
      if (fishing.get(player.pid)) return reply(ack, { ok: false, error: 'BUSY' });
      reply(ack, steals.start(player));
    });
    socket.on('steal:press', (_msg, ack) => {
      if (!player || !player.connected) return reply(ack, { ok: false, error: 'NOT_PLAYING' });
      reply(ack, steals.press(player));
    });

    // Random events: chase off a seagull (after its swoop starts), open a treasure chest together with your friend.
    socket.on('seagull:shoo', (_msg, ack) => {
      if (!player || !player.connected) return reply(ack, { ok: false, error: 'NOT_PLAYING' });
      reply(ack, seagulls.shoo(player));
    });
    socket.on('chest:open', (_msg, ack) => {
      if (!player || !player.connected || player.room.phase !== 'playing') return reply(ack, { ok: false, error: 'NOT_PLAYING' });
      reply(ack, chests.open(player));
    });

    // Rescue: whoever is on dry land throws a lifebuoy to a swimmer; the swimmer grabs it and is pulled up.
    socket.on('rescue:throw', (_msg, ack) => {
      if (!player || !player.connected) return reply(ack, { ok: false, error: 'NOT_PLAYING' });
      const res = rooms.rescue(player);
      if (res.ok) io.to(player.room.code).emit('rescue:event', { type: 'offer', by: player.pid, to: res.swimmer.pid, until: res.until });
      reply(ack, res.ok ? { ok: true } : res);
    });
    socket.on('rescue:grab', (_msg, ack) => {
      if (!player || !player.connected) return reply(ack, { ok: false, error: 'NOT_PLAYING' });
      const res = rooms.grab(player);
      if (res.ok) {
        socket.emit('player:correct', { x: res.x, y: res.y });
        io.to(player.room.code).emit('rescue:event', { type: 'done', by: res.rescuer.pid, saved: player.pid, x: res.x, y: res.y });
        social.stat(res.rescuer, 'rescues');
        social.stat(player, 'rescuedBy');
        social.together([player, res.rescuer], 'rescue');
      }
      reply(ack, res.ok ? { ok: true } : res);
    });

    socket.on('combat:mode', (msg, ack) => {
      if (!player || !player.connected) return reply(ack, { ok: false, error: 'NOT_PLAYING' });
      reply(ack, rooms.setFriendly(player, msg?.friendly));
    });

    // Shared boat: board the other player's boat, step off, swap seats. Nobody changes seats with a line out.
    const boatCall = (ack, run) => {
      if (!player || !player.connected) return reply(ack, { ok: false, error: 'NOT_PLAYING' });
      if (player.swimming) return reply(ack, { ok: false, error: 'SWIMMING' });
      if (fishing.get(player.pid) || (player.boatWith && fishing.get(player.boatWith.pid))) return reply(ack, { ok: false, error: 'BUSY' });
      reply(ack, run());
    };
    socket.on('boat:board', (_msg, ack) => boatCall(ack, () => {
      const res = rooms.board(player);
      if (res.ok) social.together([player, player.boatWith], 'boatTogether');
      return res;
    }));
    // Photo mode: the browser takes the picture; the server only counts it (and rate limits it).
    socket.on('social:photo', (_msg, ack) => {
      if (!player || !player.connected || player.room.phase !== 'playing') return reply(ack, { ok: false, error: 'NOT_PLAYING' });
      reply(ack, social.photo(player));
    });
    // The title shown next to your name: one you have earned, or null for none.
    socket.on('social:title', (msg, ack) => {
      if (!player || !profileId) return reply(ack, { ok: false, error: 'NO_PROFILE' });
      reply(ack, social.chooseTitle(player, typeof msg?.id === 'string' ? msg.id : null));
    });
    socket.on('boat:leave', (_msg, ack) => boatCall(ack, () => rooms.disembark(player)));
    socket.on('boat:switch', (_msg, ack) => boatCall(ack, () => rooms.switchSeat(player)));

    socket.on('player:state', (msg) => {
      if (!player || player.room.phase !== 'playing') return;
      // The boat holds still while its passenger has a line out.
      if (player.seat === 'driver' && fishing.get(player.boatWith.pid)) return socket.emit('player:correct', { x: player.x, y: player.y });
      const res = rooms.applyMove(player, msg);
      if (res.ok) for (const other of rooms.neighbours(player)) io.to(other.socketId).emit('player:state', res.state);
      else socket.emit('player:correct', res.correct);
    });

    socket.on('disconnect', () => {
      if (profileId && bound.get(profileId)?.socketId === socket.id) bound.delete(profileId);
      // Ignore if this slot was already taken over by a newer socket.
      if (player && player.socketId === socket.id) {
        fishing.cancel(player.pid); // the line is gone; the client resets itself on reconnect
        steals.cancelFor(player);
        duels.cancelFor(player);
        bossFights.cancelFor(player);
        rush.cancelFor(player);
        rooms.disconnect(player);
      }
    });
  });

  return new Promise((resolve) => {
    httpServer.listen(port, () => {
      const { port: actual } = httpServer.address();
      resolve({
        port: actual,
        rooms,
        fishing,
        economy,
        steals,
        rush,
        duels,
        challenges,
        social,
        bossFights,
        seagulls,
        chests,
        store,
        /** Sizes of the server's in-memory tables: all must drop back to zero when everyone has left (no leaks). */
        worldSeed,
        worldFor,
        stats: () => ({ rooms: rooms.rooms.size, players: players.size, bound: bound.size, sessions: fishing.active.size }),
        close: () => new Promise((done) => {
          bossFights.close();
          clearInterval(boatTimer);
          io.close(() => {
            store.close?.();
            done();
          });
        }),
      });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3001;
  const graceMs = Number(process.env.FT_GRACE_MS) || 30000;
  const dbFile = process.env.FT_DB === ':memory:' ? null : path.resolve(ROOT, process.env.FT_DB || 'data/fishing.sqlite');
  createGameServer({ port, graceMs, dbFile, random: true }).then((s) => {
    console.log(`[server] listening on http://localhost:${s.port}  (database: ${dbFile ?? 'memory only'})`);
    const stop = () => s.close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}
