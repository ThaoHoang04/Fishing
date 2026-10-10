import Phaser from 'phaser';
import { SCENES, TEXTURES } from '../constants/assetKeys.js';
import { TILE_SIZE, NET_SEND_HZ } from '../config.js';
import {
  MAP_COLS, MAP_ROWS, WORLD_W, WORLD_H, LAKE, LAKE_FRAMES, GRASS_FRAME, DOCK, PROPS, PLAYER_SPAWNS, SHOP,
} from '../data/world.js';
import spotsData from '../data/spots.json';
import Player from '../entities/Player.js';
import RemotePlayer from '../entities/RemotePlayer.js';
import { SLOT_COLORS } from '../entities/NameTag.js';
import FishingSystem from '../systems/FishingSystem.js';
import FishingSessions from '../systems/FishingSessions.js';
import { NetFishingBackend, LocalFishingBackend } from '../systems/FishingBackends.js';
import speciesData from '../data/allSpecies.js';
import RareToast from '../ui/RareToast.js';
import { wantsTouch } from '../ui/TouchControls.js';
import ShopUI from '../ui/ShopUI.js';
import WalletHud from '../ui/WalletHud.js';
import { createLocalEconomy, LocalEconomyClient } from '../systems/LocalEconomy.js';
import Emotes from '../ui/Emotes.js';
import ChatBubbles from '../ui/ChatBubbles.js';
import ChatUI from '../ui/ChatUI.js';
import CombatFx from '../ui/CombatFx.js';
import DuelHud from '../ui/DuelHud.js';
import RandomFx from '../ui/RandomFx.js';
import PhotoUI from '../ui/PhotoUI.js';
import { STEAL } from '../systems/Steal.js';
import { MOVES } from '../systems/Combat.js';
import CombatHud from '../ui/CombatHud.js';
import duelData from '../data/duel.json';
import ScoreHud, { addToStats } from '../ui/ScoreHud.js';
import { isRareOrBetter } from '../systems/FishingRules.js';
import { reportError } from '../ui/errorToast.js';
import behaviourData from '../data/behaviours.json';
import FishingSpot, { SPOT_RADIUS } from '../entities/FishingSpot.js';
import ZoneMarker from '../entities/ZoneMarker.js';
import Boat from '../entities/Boat.js';
import WorldFx from '../ui/WorldFx.js';
import { createWorld } from '../systems/World.js';
import { getMap, LAKE_MAP, portalAt } from '../data/maps.js';

const BOARD_RANGE = 30; // keep in step with the server (server/rooms.js)
const REAR = { left: [1, 0], right: [-1, 0], up: [0, 1], down: [0, -1] }; // the back of a boat facing that way
const SEAT_OFFSET = 7; // pixels from the boat's centre to a seat
const STEAL_ERRORS = {
  FRIENDLY: 'Friendly mode is on: press F to allow stealing',
  TARGET_FRIENDLY: 'They are in Friendly mode',
  NO_TARGET: 'Stand next to your friend to steal',
  NOTHING_TO_STEAL: 'No fresh fish to steal (3 seconds after a catch)',
  BAG_FULL: 'Your bag is full',
  NOT_HERE: 'No stealing at sea or on a boat',
  SWIMMING: 'You cannot do that while swimming',
  BUSY: 'Reel in your line first',
  DUEL_ACTIVE: 'A duel is already on',
};
const RESCUE_OFFER_MS = 5000; // keep in step with the server (server/rooms.js)
const RESCUE_RANGE = 64;
const RESCUE_ERRORS = {
  NO_SWIMMER: 'Nobody in the water close enough',
  NO_OFFER: 'No lifebuoy to grab',
  NOT_HERE: 'No swimming rescues at sea',
  NO_ROOM: 'No dry spot to pull you up',
  SWIMMING: 'You are in the water yourself',
};
const FIGHT_ERRORS = {
  SWIMMING: 'You cannot do that while swimming',
  FRIENDLY: 'Friendly mode is on: press F to allow fighting',
  TARGET_FRIENDLY: 'They are in Friendly mode',
  NOT_HERE: 'Only K or H (shove) work on a boat',
  BUSY: 'Reel in your line first',
  IN_FIGHT: 'Wait a moment, the fight is not over',
};
const BOAT_ERRORS = {
  BUSY: 'Reel in your line first',
  TOO_FAR: 'Sail closer to your friend\'s boat',
  NO_BOAT: 'Your friend is not at sea',
  WRONG_MAP: 'Boats are shared at sea',
  ALREADY_ABOARD: 'You are already aboard',
  NOT_ABOARD: 'You are not on a shared boat',
  NO_ROOM: 'No room to step off here',
  PASSENGER: 'Only the driver can sail into the harbour',
};
import hatsData from '../data/hats.json';
import conditionsData from '../data/conditions.json';
import eventsData from '../data/events.json';

const PROP_TEXTURES = {
  tree: TEXTURES.PROP_TREE,
  rock: TEXTURES.PROP_ROCK,
  bush: TEXTURES.PROP_BUSH,
  sign: TEXTURES.PROP_SIGN,
  stall: TEXTURES.SHOP_STALL,
};

// Sunset Lake: the single MVP map.
// mode 'local'  = two players on one keyboard (dev/testing, no server needed)
// mode 'online' = this client controls one player, the other arrives over the network (Phase 2)
export default class GameScene extends Phaser.Scene {
  constructor() {
    super(SCENES.GAME);
  }

  init(data) {
    this.mode = data?.mode === 'online' ? 'online' : 'local';
    this.map = getMap(data?.mapId) ?? LAKE_MAP; // which map this scene shows (a map change restarts the scene)
    this.leaving = false;
    // Phaser reuses this scene object when it restarts for another map: forget what the previous map created.
    this.stallLabel = null;
    this.boatLabel = null;
    this.portalLabels = null;
    this.waterTiles = null;
    this.flashUntil = 0;
  }

  create() {
    this.world = createWorld({ conditions: conditionsData, events: eventsData, lucky: this.mode === 'online' ? this.registry.get('net')?.world?.lucky ?? null : null });
    this.localSeed = Math.floor(Math.random() * 0xffffffff); // the sky in offline mode
    if (this.map.movement === 'boat') {
      this.buildOcean();
    } else {
      this.buildGround();
      this.buildDock();
      this.buildProps();
      this.buildRipples();
      this.buildMooredBoat();
      this.buildArena();
    }

    // This map's fishing places: fixed standing points, and (at sea) circles the boat can fish anywhere inside.
    const here = (d) => (d.map ?? 'lake') === this.map.id;
    this.spots = spotsData.filter((d) => here(d) && d.type !== 'zone').map((d) => new FishingSpot(this, d));
    this.zones = spotsData.filter((d) => here(d) && d.type === 'zone').map((d) => new ZoneMarker(this, d));
    this.players = []; // locally controlled players
    this.fishers = []; // one FishingSystem per local player
    this.remotes = new Map(); // pid -> RemotePlayer
    this.followIndex = 0;

    if (this.mode === 'online') this.createOnline();
    else this.createLocal();

    this.sfx = this.registry.get('sfx');
    this.toast = new RareToast(this);
    this.wallet = new WalletHud(this);
    this.emotes = new Emotes(this);
    this.chatBubbles = new ChatBubbles(this);
    this.combatFx = new CombatFx(this);
    this.swimGfx = this.add.graphics().setDepth(4900); // water around swimmers' legs
    this.offerUntil = 0; // a lifebuoy was thrown to us: grab it before then
    this.boatTilt = 0; // how far the shared boat leans (-1..1), from the server
    this.bumpAt = 0;
    this.duelHud = new DuelHud(this);
    this.randomFx = new RandomFx(this);
    this.photoMoment = null; // {caption, until}: something worth a photo just happened
    this.photo = new PhotoUI({
      onOpen: () => { this.input.keyboard.enabled = false; this.input.keyboard.disableGlobalCapture(); this.input.keyboard.resetKeys(); },
      onClose: () => { const kb = this.input?.keyboard; if (kb) { kb.enabled = true; kb.enableGlobalCapture(); kb.resetKeys(); } }, // (it runs a moment late: the scene may be gone)
    });
    this.stealChance = null; // {pid, speciesId, until}: the other player just landed a fish we may steal
    this.stunUntil = 0; // we are dizzy until then (a hit)
    // Text chat is online only (offline, Enter is the second player's fishing key). While the input is open the game ignores the keyboard.
    const keyboard = this.input.keyboard;
    this.chat = this.mode === 'online'
      ? new ChatUI({
        send: (text) => this.net.chat(text),
        onOpen: () => { keyboard.enabled = false; keyboard.disableGlobalCapture(); keyboard.resetKeys(); }, // capture would swallow typed spaces
        onClose: () => { keyboard.enabled = true; keyboard.enableGlobalCapture(); keyboard.resetKeys(); },
      })
      : null;
    this.cds = {}; // key -> {until, total}: the cooldowns shown on the fight buttons
    this.combatHud = this.mode === 'online' ? new CombatHud({ touch: wantsTouch(), press: (key) => this.hudPress(key) }) : null;
    this.score = new ScoreHud(this);
    this.worldFx = new WorldFx(this, {
      mapName: this.map.name,
      mapId: this.map.id,
      sfx: this.sfx,
      state: () => this.worldState(),
      eventInfo: (id) => eventsData.find((e) => e.id === id),
    });
    this.shop = new ShopUI({ getEconomy: () => this.economyFor(this.followIndex), onSound: (name) => this.sfx?.play(name) });
    this.events.on('fishing:rare', (e) => this.showRare(e));
    this.localStats = [{ caught: 0, biggest: 0, rare: 0 }, { caught: 0, biggest: 0, rare: 0 }]; // offline mode only
    this.events.on('fishing:caught', (c) => {
      const i = this.fishers.indexOf(c.fisher);
      if (this.mode === 'local' && i >= 0) addToStats(this.localStats[i], c, isRareOrBetter);
    });
    this.emoteReadyAt = [0, 0];
    this.sfx?.startAmbient();
    this.music = this.registry.get('music') ?? null;
    this.musicCheckAt = 0;

    // Keys: E = market (at the stall), I = bag + gear anywhere, ESC = close that / reel in / leave.
    const kb = this.input.keyboard;
    kb.on('keydown-E', () => (this.shop.isOpen ? this.shop.close() : this.openShop(true)));
    kb.on('keydown-I', () => (this.shop.isOpen ? this.shop.close() : this.openShop(false)));
    kb.on('keydown-M', () => this.sfx?.toggleMute());
    kb.on('keydown-B', () => this.tryTravel());
    kb.on('keydown-V', () => this.switchSeat());
    // Cartoon fighting (online, on foot): J slap, K push, L bonk. F toggles Friendly mode.
    ['J', 'K', 'L', 'H'].forEach((key) => kb.on(`keydown-${key}`, () => this.fightKey(key)));
    kb.on('keydown-Z', () => this.throwFish());
    kb.on('keydown-U', () => this.challengeDuel());
    kb.on('keydown-Y', () => this.answerDuel(true));
    kb.on('keydown-N', () => this.answerDuel(false));
    kb.on('keydown-F', () => this.toggleFriendly());
    this.showHelp = false; // the long key list is hidden until / is pressed: it covered a good part of the screen
    kb.on('keydown-FORWARD_SLASH', () => { this.showHelp = !this.showHelp; });
    // Rescue: R throws a lifebuoy to a swimmer, G grabs the one thrown to you.
    kb.on('keydown-R', () => this.throwBuoy());
    // Fish stealing: T asks to steal a fish just landed next to you; SPACE stops the needle in the duel.
    kb.on('keydown-T', () => this.tryStealFish());
    // Random events: C chases a seagull off your fish; O opens a treasure chest (together with your friend).
    kb.on('keydown-C', () => this.shooGull());
    kb.on('keydown-P', () => this.takePhoto());
    kb.on('keydown-O', () => this.openChest());
    kb.on('keydown-SPACE', () => this.duelPress());
    kb.on('keydown-G', () => this.grabBuoy());
    kb.on('keydown-ENTER', () => !this.shop.isOpen && this.chat?.open());
    // Emotes: 1-4 for the first player, 7-0 for the second local player.
    [['ONE', 'TWO', 'THREE', 'FOUR'], ['SEVEN', 'EIGHT', 'NINE', 'ZERO']].forEach((names, who) => {
      names.forEach((name, id) => kb.on(`keydown-${name}`, () => this.sendEmote(who, id)));
    });
    kb.on('keydown-ESC', () => {
      if (this.shop.isOpen) return this.shop.close();
      const active = this.fishers.filter((f) => f.busy && f.state !== 'result');
      if (active.length) active.forEach((f) => f.cancel('Reeled in'));
      else this.leaveToLobby();
    });
    const refresh = () => this.shop.refresh();
    for (let i = 0; i < this.players.length; i++) this.economyFor(i).on('inventory', refresh);
    this.events.once('shutdown', () => {
      for (let i = 0; i < this.players.length; i++) this.economyFor(i).off('inventory', refresh);
      this.fishers.forEach((f) => f.destroy());
      this.toast.destroy();
      this.wallet.destroy();
      this.emotes.destroy();
      this.chatBubbles.destroy();
      this.combatFx.destroy();
      this.swimGfx.destroy();
      this.duelHud.destroy();
      this.randomFx.destroy();
      this.photo.destroy();
      this.chat?.destroy();
      this.combatHud?.destroy();
      this.score.destroy();
      this.worldFx.destroy();
      this.zones.forEach((z) => z.destroy());
      this.sfx?.stopAmbient();
      if (!this.mapChanging) this.music?.stop(); // a change of map keeps the tune going
      this.shop.close();
    });

    this.cameras.main.setBounds(0, 0, this.map.width, this.map.height);
    this.cameras.main.setRoundPixels(true);
    this.followPlayer(0);
    this.cameras.main.centerOn(this.players[0].x, this.players[0].y);

    this.hud = this.add
      .text(4, 3, '', { fontFamily: 'monospace', fontSize: '8px', color: '#ffffff', backgroundColor: '#000000dd', padding: { x: 4, y: 2 }, lineSpacing: 2 })
      .setResolution(4)
      .setScrollFactor(0)
      .setDepth(10000);
    this.banner = this.add
      .text(this.scale.width / 2, this.scale.height / 2, 'Connection lost - reconnecting...', {
        fontFamily: 'monospace', fontSize: '10px', color: '#ffffff', backgroundColor: '#aa2222', padding: { x: 6, y: 4 },
      })
      .setOrigin(0.5)
      .setResolution(4)
      .setScrollFactor(0)
      .setDepth(10001)
      .setVisible(this.mode === 'online' && !this.net.online);
    this.hint = this.add
      .text(this.scale.width / 2, this.scale.height - 6, '', {
        fontFamily: 'monospace', fontSize: '8px', color: '#ffffff', backgroundColor: '#000000dd', padding: { x: 5, y: 3 },
      })
      .setOrigin(0.5, 1)
      .setResolution(4)
      .setScrollFactor(0)
      .setDepth(10000);
  }

  createLocal() {
    this.net = this.registry.get('net');
    const kb = this.input.keyboard;
    const wasd = this.gated(kb.addKeys({ up: 'W', down: 'S', left: 'A', right: 'D' }, false));
    const arrows = this.gated(kb.createCursorKeys());
    this.players = PLAYER_SPAWNS.map((spawn, i) =>
      new Player(this, { ...spawn, name: `P${i + 1}`, color: SLOT_COLORS[i] }, i === 0 ? wasd : arrows, this.map));

    kb.addCapture('TAB');
    kb.on('keydown-TAB', () => {
      this.shop.close();
      this.followPlayer((this.followIndex + 1) % this.players.length);
    });

    // Offline fishing: the same session rules the server runs, hosted in the browser.
    const act = this.gated(kb.addKeys({ space: 'SPACE', x: 'X', enter: 'ENTER', back: 'BACKSPACE' }, false));
    // Offline progress (coins, bag, gear) lives in the browser, one profile per local player.
    const economy = createLocalEconomy(['local-0', 'local-1']);
    this.econClients = [0, 1].map((i) => new LocalEconomyClient(economy, `local-${i}`));
    const backends = new Map();
    const sessions = new FishingSessions({
      spots: spotsData,
      species: speciesData,
      behaviours: behaviourData,
      hooks: {
        beforeCast: (pid) => (economy.isFull(pid) ? 'INVENTORY_FULL' : null),
        gear: (pid) => economy.gear(pid),
        conditions: (_pid, mapId) => this.worldState(mapId), // offline: the same weather rules, on the browser's own sky
        onCatch: (pid, c) => {
          const res = economy.addCatch(pid, c);
          this.econClients[Number(pid.slice(-1))].notify();
          return res;
        },
      },
      emit: (pid, event, payload) => {
        if (event === 'state') return;
        if (event === 'rare') this.events.emit('fishing:rare', { pid, name: `P${pid.slice(-1) * 1 + 1}`, ...payload }); // offline: shown on the same screen
        else backends.get(pid)?.emit(event, payload);
      },
    });
    const inputs = [{ action: act.space, cancel: act.x }, { action: act.enter, cancel: act.back }];
    this.fishers = this.players.map((player, i) => {
      const pid = `local-${i}`;
      const backend = new LocalFishingBackend(sessions, pid, () => ({ x: player.x, y: player.y }));
      backends.set(pid, backend);
      return new FishingSystem(this, player, backend, inputs[i]);
    });
  }

  createOnline() {
    const net = (this.net = this.registry.get('net'));
    const me = net.me;
    const kb = this.input.keyboard;
    const wasd = this.gated(kb.addKeys({ up: 'W', down: 'S', left: 'A', right: 'D' }, false));
    const arrows = this.gated(kb.createCursorKeys());
    const either = (a, b) => ({ get isDown() { return a.isDown || b.isDown; } });
    const keys = {
      up: either(wasd.up, arrows.up), down: either(wasd.down, arrows.down),
      left: either(wasd.left, arrows.left), right: either(wasd.right, arrows.right),
    };
    const player = new Player(this, { x: me.x, y: me.y, skin: me.skin, name: me.name, color: SLOT_COLORS[me.slot] }, keys, this.map);
    player.facing = me.facing ?? 'down';
    this.players = [player];
    this.lastSent = null;
    this.sendAcc = 0;

    const act = this.gated(kb.addKeys({ space: 'SPACE', x: 'X' }, false)); // E is the market key
    this.fishers = [new FishingSystem(this, player, new NetFishingBackend(net), { action: act.space, cancel: act.x })];

    this.syncRoster(net.room);
    const handlers = {
      room: (room) => (room ? this.onRoom(room) : this.exitToLobby()),
      remote: (s) => this.remotes.get(s.pid)?.pushState(s),
      correct: (c) => this.players[0].teleport(c.x, c.y),
      'fishing-state': (s) => s.pid !== net.pid && this.remotes.get(s.pid)?.setFishing(s),
      'fishing-rare': (r) => this.showRare(r),
      combat: (e) => this.onCombat(e),
      rescue: (e) => this.onRescue(e),
      'combat-throw': (s) => this.combatFx.fly(s, s.icon),
      'duel-offer': (e) => this.randomFx.offered(e, this.time.now),
      'duel-offered': () => this.say('Challenge sent: waiting for the answer...'),
      'duel-declined': () => this.say('They declined the duel'),
      'duel-start': (e) => {
        this.randomFx.duelStart(e, this.time.now);
        this.stunUntil = this.time.now + e.countdownMs; // everyone stands still for the countdown
        this.say('DUEL! J punch  K kick  L dodge  H shove');
      },
      'duel-hit': (e) => this.onDuelHit(e),
      'duel-end': (r) => this.randomFx.duelEnd(r, (pid) => this.nameOf(pid)),
      'seagull-attack': (e) => this.randomFx.gullAttack(this.players[0], e),
      'seagull-result': (e) => this.onGullResult(e),
      'chest-spawn': (e) => this.randomFx.chestSpawn(e),
      'chest-gone': (e) => this.randomFx.chestGone(e.id),
      'chest-opened': (e) => this.onChestOpened(e),
      'boat-tilt': (e) => { this.boatTilt = e.tilt; },
      'boat-capsized': (e) => {
        this.boatTilt = 0;
        for (const pid of e.pids) {
          const who = this.entityOf(pid);
          if (who) this.combatFx.pop(who, 'WHOOPS!', '#7fd1ff');
        }
        this.sfx?.play('splash');
        this.cameras.main.shake(220, 0.006);
        this.say(e.by
          ? (e.by === net.pid ? 'You shoved your friend overboard! They are back on their own boat in a moment' : 'SPLASH! You were shoved off the boat. Back on your own boat in a moment')
          : 'The boat flipped! You are back on your own boats in a moment');
      },
      'rush-spot': (e) => this.randomFx.rushAnnounce(e),
      'rush-claimed': (e) => this.randomFx.rushClaimed(e, (pid) => this.nameOf(pid)),
      'boss-spot': (e) => this.randomFx.bossAnnounce(e),
      'boss-gone': () => this.randomFx.bossAnnounce(null),
      'boss-hooked': (e) => e.pid !== net.pid && this.say(`${this.entityOf(e.pid)?.baseName ?? 'Your partner'} hooked the big one! Cast at the same spot to help (within ${Math.round(e.joinMs / 1000)} s)`),
      'boss-fight': (e) => this.fishers[0].startCoop(e),
      'boss-state': (s) => this.fishers[0].coopSnapshot(s),
      'boss-roles': (r) => this.fishers[0].coopRoles(r),
      'boss-result': (r) => {
        this.fishers[0].endCoop(r);
        if (r.outcome === 'caught') this.photoChance(`${r.giant ? 'GIANT LANDED' : 'BOSS DEFEATED'}: ${r.name} ${r.weight.toFixed(1)} kg`);
      },
      'social-toast': (t) => {
        this.randomFx.toast(t.kind === 'title' ? `TITLE UNLOCKED: ${t.name}` : `FRIENDSHIP LEVEL UP: ${t.name}`, t.kind === 'title' ? '#ffe14d' : '#7be08a');
        if (t.kind === 'title') this.photoChance(`New title: ${t.name}`);
      },
      'challenge-start': (e) => {
        this.randomFx.contestStart(e, this.time.now);
        this.say(e.text);
      },
      'challenge-score': (e) => this.randomFx.contestScore(e.scores),
      'challenge-end': (r) => this.randomFx.contestEnd(r, (pid) => this.nameOf(pid)),
      'steal-open': (e) => { this.stealChance = { pid: e.pid, speciesId: e.speciesId, until: this.time.now + e.ms }; },
      'steal-start': (e) => this.onStealStart(e),
      'steal-result': (e) => this.onStealResult(e),
      chat: (m) => {
        this.chat?.add(m);
        const mine = m.pid === net.pid;
        const anchor = mine ? this.players[0] : this.remotes.get(m.pid);
        if (anchor) this.chatBubbles.show(anchor, m.text);
        if (!mine) this.sfx?.play('emote');
      },
      emote: (e) => {
        const remote = this.remotes.get(e.pid);
        if (!remote) return;
        this.emotes.show(remote, e.id);
        this.sfx?.play('emote');
      },
      status: (online) => {
        this.banner.setVisible(!online);
        // The server drops our line when the socket drops; do not keep a phantom session.
        if (online) this.fishers.forEach((f) => f.busy && f.cancel('Connection restored'));
      },
    };
    for (const [event, fn] of Object.entries(handlers)) net.on(event, fn);
    this.events.once('shutdown', () => {
      for (const [event, fn] of Object.entries(handlers)) net.off(event, fn);
    });
  }

  syncRoster(room) {
    for (const info of room.players) {
      if (info.pid === this.net.pid) continue;
      const remote = this.remotes.get(info.pid);
      if ((info.mapId ?? 'lake') !== this.map.id) {
        // The other player sailed elsewhere: they are not on this map any more.
        if (remote) {
          remote.destroy();
          this.remotes.delete(info.pid);
        }
        continue;
      }
      if (remote) remote.setConnected(info.connected);
      else {
        const created = new RemotePlayer(this, info, SLOT_COLORS[info.slot], this.map);
        this.remotes.set(info.pid, created);
        const line = this.net.fishingStates.get(info.pid); // their line may already be out
        if (line) created.setFishing(line, true);
      }
    }
    for (const [pid, remote] of this.remotes) {
      if (!room.players.some((p) => p.pid === pid)) {
        remote.destroy();
        this.remotes.delete(pid);
      }
    }
  }

  /** Keys that read as released while the market/bag overlay is open, so the game ignores them. */
  gated(keys) {
    const scene = this;
    const out = {};
    for (const name of ['up', 'down', 'left', 'right', 'space', 'x', 'enter', 'back']) {
      const key = keys[name];
      if (key) out[name] = { get isDown() { return key.isDown && !scene.shop?.isOpen && !scene.chat?.isOpen && scene.time.now >= scene.stunUntil && !scene.players?.[0]?.swimming; } };
    }
    return out;
  }

  /** The inventory/trading client of local player `i` (the server connection online, the browser economy offline). */
  economyFor(i) {
    return this.mode === 'online' ? this.net : this.econClients[i];
  }

  nearShop(player) {
    const shop = this.map.shop;
    return Boolean(shop) && Math.hypot(player.x - shop.talkX, player.y - shop.talkY) <= shop.radius;
  }

  /** The shared sky for `mapId`: from the server's clock and seed online, from the browser's clock offline. */
  worldState(mapId = this.map.id) {
    if (this.mode === 'online') {
      const w = this.net.world;
      return w ? this.world.state(this.net.worldNow(), { seed: w.seed, mapId }) : null;
    }
    return this.world.state(Date.now(), { seed: this.localSeed, mapId });
  }

  /** The server moved our player to another map: leave this scene (the loader fetches what the new map needs). */
  onRoom(room) {
    const me = room.players.find((p) => p.pid === this.net.pid);
    if (me && (me.mapId ?? 'lake') !== this.map.id) return this.changeMap(me.mapId);
    return this.syncRoster(room);
  }

  changeMap(mapId) {
    if (this.leaving) return;
    this.leaving = true;
    this.mapChanging = true;
    this.shop.close();
    this.cameras.main.fadeOut(300, 5, 20, 40);
    this.time.delayedCall(320, () => this.scene.start(SCENES.LOAD_MAP, { mode: this.mode, mapId }));
  }

  /** B at a portal: the boat at the end of the pier, or the harbour at sea. */
  tryTravel() {
    if (this.shop.isOpen || this.leaving) return;
    const say = (text) => {
      this.flashText = text;
      this.flashUntil = this.time.now + 2400;
    };
    const p = this.players[0];
    const me = this.mode === 'online' ? this.myInfo() : null;
    const idle = this.fishers[0].state === 'idle' || this.fishers[0].state === 'result';
    if (me?.seat === 'passenger') {
      if (!idle) return say('Reel in your line first');
      this.net.boat('leave').then((res) => (res.ok ? this.players[0].teleport(res.x, res.y) : say(BOAT_ERRORS[res.error] ?? 'Cannot step off now')));
      return;
    }
    const portal = portalAt(this.map, p.x, p.y, 4);
    if (!portal) {
      // Not at a portal: at sea, B climbs aboard the friend's boat when it is close.
      const mate = this.mode === 'online' ? this.boardable() : null;
      if (!mate) return;
      if (!idle) return say('Reel in your line first');
      this.net.boat('board').then((res) => !res.ok && say(BOAT_ERRORS[res.error] ?? 'Cannot board now'));
      return;
    }
    if (this.mode !== 'online') return say('Sailing needs an online room (the local test is lake-only)');
    if (!idle) return say('Reel in your line first');
    this.sfx?.play('horn');
    this.net.travel(portal.id).then((res) => {
      if (!res.ok) say(res.error === 'TOO_FAR' ? 'Move closer to the boat' : BOAT_ERRORS[res.error] ?? 'Cannot sail right now');
    });
  }

  /** J / K / L. The server decides everything; the swing shows when its event comes back. */
  attack(kind) {
    const shove = this.map.movement === 'boat' && this.myInfo()?.seat && (kind === 'push' || kind === 'big'); // K / H from a shared boat
    if (this.mode !== 'online' || this.shop.isOpen || this.leaving || (this.map.movement !== 'walk' && !shove)) return;
    if (this.time.now < this.stunUntil || this.fishers[0].busy || this.players[0].swimming) return;
    this.net.attack(kind).then((res) => {
      if (res.ok) this.startCooldown({ slap: 'J', push: 'K', bonk: 'L', big: 'H' }[kind], MOVES[kind].cooldownMs);
      if (!res.ok && res.error !== 'COOLDOWN' && res.error !== 'STUNNED') this.say(FIGHT_ERRORS[res.error] ?? 'Cannot do that now');
    });
  }

  /** F: allow fighting (FIGHT) or not (Friendly). Both players must be in FIGHT mode to hit each other. */
  toggleFriendly() {
    const me = this.mode === 'online' ? this.myInfo() : null;
    if (!me || this.shop.isOpen || this.leaving) return;
    this.net.setFriendly(!me.friendly).then((res) => {
      if (!res.ok) return this.say(FIGHT_ERRORS[res.error] ?? 'Cannot change that now');
      this.say(res.friendly ? 'Friendly mode: nobody can hit you' : 'FIGHT mode: J slap, K push, L bonk (if your friend is in FIGHT mode too)');
    });
  }

  /** J / K / L / H: the cartoon moves normally; during a duel they are punch, kick, dodge and shove; H alone is the big push. */
  fightKey(key) {
    if (this.randomFx.duel) {
      if (this.mode !== 'online' || this.time.now < this.stunUntil) return;
      const kind = { J: 'punch', K: 'kick', L: 'dodge', H: 'push' }[key];
      this.net.duelAct(kind).then((res) => {
        if (res.ok) this.startCooldown(key, duelData.moves[kind].cooldownMs);
        else if (!['COOLDOWN', 'TOO_EARLY', 'STUNNED'].includes(res.error)) this.say('Cannot do that now');
      });
      return;
    }
    this.attack({ J: 'slap', K: 'push', L: 'bonk', H: 'big' }[key]);
  }

  startCooldown(key, ms) {
    if (key && ms > 0) this.cds[key] = { until: this.time.now + ms, total: ms };
  }

  /** A tap on one of the on-screen fight buttons (the keys do the same). */
  hudPress(key) {
    if (key === 'Z') this.throwFish();
    else this.fightKey(key);
  }

  /** Show the fight buttons in FIGHT mode (on foot) and in a duel; hide them otherwise. */
  updateCombatHud() {
    const me = this.myInfo();
    const inDuel = Boolean(this.randomFx.duel) && !this.shop.isOpen && !this.chat?.isOpen;
    const fighting = !this.shop.isOpen && !this.chat?.isOpen && me && me.friendly === false && this.map.movement === 'walk' && !me.seat && !me.swimming;
    this.combatHud.update({ mode: inDuel ? 'duel' : fighting ? 'fight' : null, anger: me?.anger ?? 0, cds: this.cds, now: this.time.now });
  }

  /** Z: throw a fish or piece of junk from the bag at your friend (it is not lost). */
  throwFish() {
    if (this.mode !== 'online' || this.shop.isOpen || this.leaving || this.map.movement !== 'walk' || this.randomFx.duel) return;
    if (this.time.now < this.stunUntil || this.fishers[0].busy || this.players[0].swimming) return;
    this.net.throwItem().then((res) => {
      if (res.ok) this.startCooldown('Z', MOVES.throw.cooldownMs);
      if (res.ok || res.error === 'COOLDOWN') return;
      this.say({ NO_AMMO: 'Nothing small to throw: catch some junk or a minnow first', FRIENDLY: FIGHT_ERRORS.FRIENDLY, BUSY: FIGHT_ERRORS.BUSY }[res.error] ?? 'Cannot throw now');
    });
  }

  /** U: challenge your friend to a duel (health, punches, kicks; nothing is lost). They answer Y or N. */
  challengeDuel() {
    if (this.mode !== 'online' || this.shop.isOpen || this.leaving || this.randomFx.duel) return;
    this.net.duelChallenge().then((res) => {
      if (res.ok) return;
      this.say({ OFFER_PENDING: 'You already challenged them', COOLDOWN: 'Wait a moment before challenging again', NOT_HERE: 'Duels are on foot, on the same map', BUSY: 'Finish what you are doing first', DUEL_ON: 'A duel is already on', NO_ONE: 'Nobody to challenge' }[res.error] ?? 'Cannot challenge now');
    });
  }

  answerDuel(accept) {
    if (this.mode !== 'online' || !this.randomFx.duelOffer || this.time.now > this.randomFx.duelOffer.until) return;
    this.net.duelRespond(accept);
    this.randomFx.duelOffer = null;
  }

  onDuelHit(e) {
    const from = this.entityOf(e.from);
    const to = e.to ? this.entityOf(e.to) : null;
    this.randomFx.duelHp(e.hp);
    if (e.kind === 'dodge') {
      if (from) this.combatFx.pop(from, 'DODGE!', '#9fe3ff');
      this.sfx?.play('swish');
      return;
    }
    if (e.dodged) {
      if (to) this.combatFx.pop(to, 'DODGED!', '#9fe3ff');
      this.sfx?.play('swish');
      return;
    }
    if (to) this.combatFx.pop(to, `-${e.dmg}`, '#ff6b6b');
    this.sfx?.play(e.kind === 'kick' ? 'bonk' : e.kind === 'push' ? 'push' : 'slap');
    if (to === this.players[0]) {
      to.teleport(e.x, e.y);
      this.stunUntil = this.time.now + e.stunMs;
      this.cameras.main.shake(120, 0.004);
    } else if (to) {
      to.knock(e.x, e.y);
    }
  }

  /** "ANGRY!" when the meter is full and the friend is in FIGHT mode too. */
  angerHint() {
    const me = this.myInfo();
    if (!me || me.anger < 100 || me.friendly !== false || this.map.movement !== 'walk') return '';
    return 'ANGRY! Press H for a BIG PUSH!';
  }

  onCombat(e) {
    const from = this.entityOf(e.from);
    const to = e.to ? this.entityOf(e.to) : null;
    const move = MOVES[e.kind];
    if (!move) return;
    this.sfx?.play(to ? (e.fell ? 'splash' : e.kind) : 'swish');
    if (e.kind === 'big') this.cameras.main.shake(260, 0.01);
    if (from) this.combatFx.pop(from, to ? move.label : '...', to ? '#ffe14d' : '#cfe6ff');
    if (!to) return;
    if (e.fell) this.combatFx.pop(to, 'SPLASH!', '#7fd1ff');
    this.combatFx.stars(to, e.stunMs);
    if (to === this.players[0]) {
      to.teleport(e.x, e.y);
      this.stunUntil = this.time.now + e.stunMs;
      if (this.fishers[0].busy) this.fishers[0].cancel('Knocked off your line!');
      this.cameras.main.shake(160, 0.006);
    } else {
      to.knock(e.x, e.y);
    }
  }

  /** Which tune fits right now: the boss fight, the night, or the lake. Checked twice a second. */
  updateMusic() {
    if (!this.music || this.time.now < this.musicCheckAt) return;
    this.musicCheckAt = this.time.now + 500;
    const theme = this.fishers.some((f) => f.isCoop && f.coop) ? 'boss' : this.worldState()?.time === 'night' ? 'night' : 'lake';
    this.music.setTheme(theme);
    this.music.sync(); // the audio may only just have been unlocked by the first key press
  }

  photoHint() {
    return this.photoMoment && this.time.now < this.photoMoment.until && !this.photo.isOpen ? 'P: Take a photo of the moment!' : '';
  }

  /** A player's display name from their id (ours included). */
  nameOf(pid) {
    return this.net.room?.players.find((p) => p.pid === pid)?.name ?? 'Someone';
  }

  /** Something photo-worthy happened: for 20 seconds P takes a picture of it. */
  photoChance(caption) {
    this.photoMoment = { caption, until: this.time.now + 20000 };
  }

  /** P: take a photo of the moment (the screen as it is now), in a polaroid frame you can save. */
  takePhoto() {
    if (this.mode !== 'online' || this.photo.isOpen || this.shop.isOpen || !this.photoMoment || this.time.now > this.photoMoment.until) return;
    const { caption } = this.photoMoment;
    this.photoMoment = null;
    // The canvas is only readable right after it has been drawn: wait for the end of this frame.
    this.game.events.once('postrender', () => {
      let image = '';
      try {
        image = this.game.canvas.toDataURL('image/png');
      } catch {
        /* a browser that will not give the canvas up: no photo, no harm */
      }
      if (!image) return this.say('Could not take the photo here');
      const names = (this.net.room?.players ?? []).map((p) => p.name).join(' & ');
      this.photo.open({ image, caption, names });
      this.net.photoTaken().then((res) => res.ok || res.error === 'COOLDOWN' || this.say('The photo was not counted'));
    });
  }

  /** C: chase the seagull (once it swoops). */
  shooGull() {
    if (this.mode !== 'online' || !this.randomFx.gull) return;
    this.net.shooGull().then((res) => {
      if (!res.ok && res.error === 'TOO_EARLY') this.say('Too early! Wait until it swoops');
    });
  }

  onGullResult(e) {
    this.randomFx.gullDone();
    const fish = speciesData.find((f) => f.id === e.speciesId)?.name ?? 'fish';
    this.say(e.stolen ? `The seagull flew off with your ${fish}!` : 'You chased the seagull away!');
    this.sfx?.play(e.stolen ? 'error' : 'record');
  }

  /** O: open the treasure chest nearby. It only opens when your friend presses it too. */
  openChest() {
    if (this.mode !== 'online' || this.shop.isOpen || !this.randomFx.chestNear(this.players[0], this.map.id)) return;
    this.net.openChest().then((res) => {
      if (res.ok && res.waiting) this.say('Waiting for your friend to press O too...');
      else if (!res.ok && res.error === 'TOO_FAR') this.say('Get closer to the chest');
    });
  }

  onChestOpened(e) {
    this.randomFx.chestOpened(e.id, [this.entityOf(e.by[0]), this.entityOf(e.by[1])], e.each);
    this.say(`The chest held ${e.total} coins: ${e.each} each!`);
    this.sfx?.play('sell');
  }

  /** The glowing "lucky spot" (if any) and the little label under the clock chip. */
  updateLucky() {
    const state = this.worldState();
    this.randomFx.lucky(state?.lucky ?? null, this.spots, this.time.now, this.net.worldNow());
    const room = this.net.room;
    this.randomFx.rushState(room?.rush ? { ...room.rush, until: this.time.now + room.rush.remainingMs - (performance.now() - room.receivedAt) } : null, this.spots);
    this.randomFx.bossSpot(room?.boss ? { ...room.boss, until: this.time.now + room.boss.remainingMs - (performance.now() - room.receivedAt) } : null, this.spots);
  }

  /** T: try to steal the fish your friend just landed. Both need FIGHT mode; the duel starts for both. */
  tryStealFish() {
    if (this.mode !== 'online' || this.shop.isOpen || this.leaving || this.map.movement !== 'walk') return;
    if (this.time.now < this.stunUntil || this.fishers[0].busy || this.players[0].swimming || this.duelHud.isActive) return;
    this.net.stealStart().then((res) => {
      if (res.ok) return;
      if (res.error === 'COOLDOWN') return this.say(`You can steal again in ${Math.ceil((res.ms ?? 0) / 1000)} s`);
      if (res.error !== 'STUNNED') this.say(STEAL_ERRORS[res.error] ?? 'Cannot steal now');
    });
  }

  onStealStart(e) {
    const me = this.net.pid;
    const species = speciesData.find((f) => f.id === e.speciesId);
    const name = (pid) => (pid === me ? 'You' : this.entityOf(pid)?.baseName ?? this.myInfo()?.name ?? 'Your friend');
    const title = e.thief === me ? `Steal the ${species?.name ?? 'fish'}!` : `${name(e.thief)} is stealing your ${species?.name ?? 'fish'}!`;
    this.stealChance = null;
    this.sfx?.play('steal');
    this.stunUntil = this.time.now + e.startIn + e.durationMs + 200; // both stand still for the duel
    this.fishers.forEach((f) => f.card.hide());
    this.duelHud.begin({ startIn: e.startIn, durationMs: e.durationMs, period: e.period, zone: e.zone, title });
  }

  /** SPACE during a duel: stop the needle (the server decides how good it was). */
  duelPress() {
    if (!this.duelHud.isActive || !this.duelHud.press()) return;
    this.net.stealPress();
  }

  onStealResult(e) {
    this.duelHud.end();
    this.stunUntil = 0;
    if (e.cancelled) return this.say('The duel was called off');
    const me = this.net.pid;
    const species = speciesData.find((f) => f.id === e.speciesId);
    const fish = species?.name ?? 'fish';
    const loser = this.entityOf(e.loser);
    if (loser) {
      this.combatFx.stars(loser, e.stunMs);
      this.combatFx.pop(loser, e.thiefWon ? 'OH NO!' : 'DENIED!', '#ff8a8a');
    }
    if (loser === this.players[0]) this.stunUntil = this.time.now + e.stunMs;
    const thief = e.thief === me;
    this.say(e.thiefWon
      ? (thief ? `You stole the ${fish}!` : `${this.entityOf(e.thief)?.baseName ?? 'Your friend'} stole your ${fish}!`)
      : (thief ? `Caught! The ${fish} stays with ${this.entityOf(e.victim)?.baseName ?? 'its owner'}` : `You kept your ${fish}!`));
    this.sfx?.play(e.thiefWon === thief ? 'record' : 'error');
  }

  /** The prompt for a steal chance: your friend just landed a fish, you are next to them and both are in FIGHT mode. */
  stealHint() {
    const c = this.stealChance;
    if (!c || this.time.now > c.until + STEAL.SLACK_MS || this.duelHud.isActive) return '';
    const victim = this.entityOf(c.pid);
    const mine = this.myInfo();
    const theirs = this.net.room?.players.find((p) => p.pid === c.pid);
    const me = this.players[0];
    if (!victim || !mine || mine.friendly !== false || theirs?.friendly !== false || me.swimming) return '';
    if (Math.hypot(victim.x - me.x, victim.y - me.y) > STEAL.RANGE) return '';
    const fish = speciesData.find((f) => f.id === c.speciesId)?.name ?? 'fish';
    return `T: Steal ${victim.baseName}'s ${fish}!`;
  }

  /** R: throw a lifebuoy to a swimmer within reach. */
  throwBuoy() {
    if (this.mode !== 'online' || this.shop.isOpen || this.leaving || this.map.movement !== 'walk') return;
    if (this.time.now < this.stunUntil || this.players[0].swimming) return;
    this.net.rescueThrow().then((res) => !res.ok && res.error !== 'COOLDOWN' && this.say(RESCUE_ERRORS[res.error] ?? 'Cannot do that now'));
  }

  /** G: grab the lifebuoy thrown to us. */
  grabBuoy() {
    if (this.mode !== 'online' || !this.players[0].swimming) return;
    this.net.rescueGrab().then((res) => !res.ok && this.say(RESCUE_ERRORS[res.error] ?? 'Cannot grab it now'));
  }

  onRescue(e) {
    if (e.type === 'offer') {
      const swimmer = this.entityOf(e.to);
      if (swimmer) this.combatFx.buoy(swimmer, RESCUE_OFFER_MS);
      if (e.to === this.net.pid) this.offerUntil = this.time.now + RESCUE_OFFER_MS;
      return;
    }
    const saved = this.entityOf(e.saved);
    if (saved) {
      this.combatFx.clearBuoy(saved);
      this.combatFx.pop(saved, 'RESCUED!', '#7be08a');
    }
    if (e.saved === this.net.pid) this.offerUntil = 0;
    this.sfx?.play('rescue');
  }

  /** Who is in the water (from the room state): flags, a blue tint, and the water drawn over their legs. */
  updateSwimming() {
    this.swimGfx.clear();
    const t = this.time.now / 300;
    for (const info of this.net.room?.players ?? []) {
      const entity = this.entityOf(info.pid);
      if (!entity) continue;
      entity.swimming = Boolean(info.swimming);
      const swimming = entity.swimming || Boolean(info.capsized); // a flipped boat's crew splashes about too
      if (swimming !== Boolean(entity.tinted)) {
        entity.tinted = swimming;
        if (swimming) entity.sprite.setTint(0xbfe3ff);
        else entity.sprite.clearTint();
      }
      if (!swimming) continue;
      const x = Math.round(entity.x);
      const y = Math.round(entity.y);
      this.swimGfx.fillStyle(0x3d9be9, 0.6).fillEllipse(x, y - 4, 18, 8);
      this.swimGfx.lineStyle(1, 0xdff3ff, 0.8).strokeEllipse(x, y - 4, 20 + Math.sin(t) * 3, 9 + Math.sin(t) * 1.5);
    }
  }

  /** Boats lean when both crew lean the same way, and lie upside down while their crew is dunked. */
  updateBoatAngles() {
    const room = this.net.room;
    if (!room) return;
    if (!this.myInfo()?.seat) this.boatTilt = 0;
    for (const info of room.players) {
      const entity = this.entityOf(info.pid);
      if (!entity?.boat) continue;
      const angle = info.capsized ? 180 : info.seat === 'driver' ? this.boatTilt * 22 : 0;
      entity.boat.sprite.setAngle(angle).setAlpha(info.capsized ? 0.65 : 1);
    }
    const me = this.players[0];
    if (me.bumped && this.time.now > this.bumpAt) {
      this.bumpAt = this.time.now + 450;
      this.cameras.main.shake(90, 0.003);
      this.sfx?.play('bump');
    }
  }

  tiltHint() {
    return Math.abs(this.boatTilt) > 0.45 && this.myInfo()?.seat ? 'WOBBLY! Do not both lean the same way!' : '';
  }

  /** What the controls line should say about swimming and rescues (or ''). */
  swimHint() {
    const me = this.players[0];
    if (me.swimming) return this.time.now < this.offerUntil ? 'G: Grab the lifebuoy!' : 'You fell in! Swim to the shore, or wait for a rescue';
    for (const r of this.remotes.values()) {
      if (r.swimming && r.connected && Math.hypot(r.x - me.x, r.y - me.y) <= RESCUE_RANGE) return `R: Throw a lifebuoy to ${r.baseName}`;
    }
    return '';
  }

  /** Hats: a small sprite on top of each head, following whoever wears it (the server says which hat). */
  updateHats() {
    this.hatSprites ??= new Map();
    const seen = new Set();
    for (const info of this.net.room?.players ?? []) {
      const entity = this.entityOf(info.pid);
      if (!info.hat || !entity || entity.connected === false || !hatsData[info.hat]) continue;
      seen.add(info.pid);
      let sprite = this.hatSprites.get(info.pid);
      if (!sprite || sprite.hatId !== info.hat) {
        sprite?.destroy();
        sprite = this.add.image(0, 0, `hat_${info.hat}`).setOrigin(0.5, 1);
        sprite.hatId = info.hat;
        this.hatSprites.set(info.pid, sprite);
      }
      sprite.setPosition(entity.sprite.x, entity.sprite.y - 9).setDepth(entity.sprite.depth + 0.5).setVisible(entity.sprite.visible);
    }
    for (const [pid, sprite] of this.hatSprites) {
      if (seen.has(pid)) continue;
      sprite.destroy();
      this.hatSprites.delete(pid);
    }
  }

  /** The name tag says [FIGHT] for anyone who is open to a brawl. */
  updateFightTags() {
    for (const info of this.net.room?.players ?? []) {
      const entity = this.entityOf(info.pid);
      if (!entity || entity.connected === false) continue;
      const text = `${info.name}${info.title ? ` - ${info.title}` : ''}${info.friendly === false ? ' [FIGHT]' : ''}`;
      if (entity.tagText !== text) {
        entity.tagText = text;
        entity.label.setText(text);
      }
    }
  }

  /** Our room entry (seat, mapId, ...), online only. */
  myInfo() {
    return this.net.room?.players.find((p) => p.pid === this.net.pid) ?? null;
  }

  /** Our player or someone else's, by id. */
  entityOf(pid) {
    return pid === this.net.pid ? this.players[0] : this.remotes.get(pid) ?? null;
  }

  /** At sea, the friend whose boat we could climb aboard right now (close, and not already sharing). */
  boardable() {
    if (this.map.movement !== 'boat' || this.myInfo()?.seat) return null;
    const p = this.players[0];
    for (const r of this.remotes.values()) {
      if (r.connected && !r.seated && Math.hypot(r.x - p.x, r.y - p.y) <= BOARD_RANGE) return r;
    }
    return null;
  }

  /** V: swap who steers and who rides. */
  switchSeat() {
    if (this.mode !== 'online' || this.shop.isOpen || this.leaving || !this.myInfo()?.seat) return;
    const state = this.fishers[0].state;
    if (state !== 'idle' && state !== 'result') return this.say('Reel in your line first');
    this.net.boat('switch').then((res) => !res.ok && this.say(BOAT_ERRORS[res.error] ?? 'Cannot swap seats now'));
  }

  say(text) {
    this.flashText = text;
    this.flashUntil = this.time.now + 2400;
  }

  /**
   * Shared boats: a passenger takes the driver's position and sits at the back; the driver at the front.
   * The boat holds still (our player is "held") while the passenger has a line out.
   */
  updateCrews() {
    const mine = this.players[0];
    const all = [mine, ...this.remotes.values()];
    for (const e of all) {
      e.seated = false;
      e.follow = null;
      e.ride.x = 0;
      e.ride.y = 0;
    }
    mine.held = false;
    for (const info of this.net.room?.players ?? []) {
      if (info.seat !== 'passenger') continue;
      const passenger = this.entityOf(info.pid);
      const driver = this.entityOf(info.boatWith);
      if (!passenger || !driver) continue;
      passenger.seated = true;
      passenger.follow = driver;
      const [rx, ry] = REAR[driver.fish?.facing ?? driver.facing] ?? REAR.down;
      passenger.ride.x = rx * SEAT_OFFSET;
      passenger.ride.y = ry * SEAT_OFFSET;
      driver.ride.x = -rx * SEAT_OFFSET;
      driver.ride.y = -ry * SEAT_OFFSET;
      const fishing = passenger === mine ? this.fishers[0].busy : Boolean(passenger.fish);
      if (driver === mine && fishing) mine.held = true;
    }
  }

  openShop(needStall) {
    const i = this.followIndex;
    const state = this.fishers[i].state;
    if (state !== 'idle' && state !== 'result') return; // a line is out: finish (or reel in) first. After a catch, trade right away.
    const atShop = this.nearShop(this.players[i]);
    if (needStall && !atShop) return;
    this.fishers.forEach((f) => f.card.hide()); // the catch card would sit underneath the market
    this.shop.open({ atShop });
  }

  followPlayer(i) {
    this.followIndex = i;
    // Rigid follow (lerp 1) + rounded sprite positions: the character stays on the same screen pixel,
    // so nothing shimmers against the tiles. Smoothing would give fractional scroll values.
    this.cameras.main.startFollow(this.players[i].sprite, true, 1, 1);
  }

  leaveToLobby() {
    if (this.mode === 'online') this.net.leave(); // emits room=null -> exitToLobby
    else this.exitToLobby();
  }

  exitToLobby() {
    if (this.scene.isActive(SCENES.GAME)) this.scene.start(SCENES.LOBBY);
  }

  update(_time, delta) {
    // An exception inside Phaser's loop would stop the game for good: log it once and keep going.
    try {
      this.tick(delta);
    } catch (err) {
      reportError(err);
    }
  }

  tick(delta) {
    const dt = Math.min(delta, 50) / 1000;
    if (this.mode === 'online') {
      this.updateSwimming();
      this.updateLucky();
      this.updateCrews();
      this.updateBoatAngles();
      this.updateFightTags();
      this.updateCombatHud();
    }
    this.players[0].stunned = this.time.now < this.stunUntil;
    for (const p of this.players) p.update(dt);
    if (this.mode === 'online') this.updateHats();
    this.fishers.forEach((f, i) => {
      const bag = this.economyFor(i).state;
      f.hudVisible = i === this.followIndex;
      f.bagFull = Boolean(bag) && bag.items.length >= bag.capacity;
      f.update(dt, this.spotNear(this.players[i]));
    });
    this.wallet.update(this.economyFor(this.followIndex).state);
    this.worldFx.update(dt);
    for (const z of this.zones) z.update(dt, this.players.some((p) => z.contains(p.x, p.y)));
    if (this.waterTiles) this.updateWater(dt);
    const here = portalAt(this.map, this.players[this.followIndex].x, this.players[this.followIndex].y, 4);
    if (this.portalLabels) for (const [id, label] of this.portalLabels) label.setColor(here?.id === id ? '#ffe14d' : '#ffffff');
    else this.boatLabel?.setColor(here ? '#ffe14d' : '#ffffff');
    this.emotes.update();
    this.chatBubbles.update();
    this.combatFx.update();
    this.updateMusic();
    this.randomFx.contestSync(this.net.room, this.time.now);
    this.randomFx.update(this.players[0], (pid) => this.nameOf(pid));
    this.duelHud.update();
    this.score.update(
      this.mode === 'online'
        ? this.net.room?.players ?? []
        : this.players.map((_, i) => ({ name: `P${i + 1}`, slot: i, stats: this.localStats[i] })),
    );
    this.stallLabel?.setColor(this.nearShop(this.players[this.followIndex]) ? '#ffe14d' : '#ffffff');
    if (this.mode === 'online') {
      this.sendState(dt);
      const now = performance.now();
      for (const r of this.remotes.values()) r.update(now, dt);
    }

    for (const spot of this.spots) {
      const near = this.players.some((p) => spot.distanceTo(p.x, p.y) <= SPOT_RADIUS);
      // The marker would sit on top of someone who is already fishing there, so hide it while in use.
      const occupied = this.fishers.some((f) => f.busy && f.spot === spot)
        || [...this.remotes.values()].some((r) => r.fish && spot.distanceTo(r.x, r.y) <= SPOT_RADIUS);
      spot.marker.setVisible(!occupied);
      spot.setHighlight(near && !occupied);
    }

    const cam = this.players[this.followIndex];
    const sound = this.sfx?.muted ? 'sound OFF' : 'sound on';
    const touch = wantsTouch(); // no key list on a touch screen: the buttons are on screen
    const controls = touch
      ? `${cam.label.text.text}${this.mode === 'online' && this.map.movement === 'walk' ? `   ${this.myInfo()?.friendly === false ? 'FIGHT' : 'Friendly'}  ANGER ${Math.round(this.myInfo()?.anger ?? 0)}%${(this.myInfo()?.anger ?? 0) >= 100 ? '  BIG = H' : ''}` : ''}`
      : this.mode === 'online' && !this.showHelp
      ? `${cam.label.text.text}   ${this.map.movement === 'walk' ? (this.myInfo()?.friendly === false ? 'FIGHT' : 'Friendly') + '   ' : ''}/ = keys`
      : this.mode === 'online'
      ? `${cam.label.text.text}: WASD ${this.map.movement === 'boat' ? 'sail' : 'move'}  SPACE fish  X let go\n${this.map.shop ? 'E market  ' : ''}I bag  B boat  V seat  1-4 emote  ENTER chat  M ${sound}  ESC leave${this.map.movement === 'walk' ? `\nF mode: ${this.myInfo()?.friendly === false ? 'FIGHT' : 'Friendly'}   J slap  K push  L bonk  Z throw  R rescue  T steal  U duel\nANGER ${Math.round(this.myInfo()?.anger ?? 0)}%${(this.myInfo()?.anger ?? 0) >= 100 ? '  H: BIG PUSH' : ''}` : ''}`
      : `P1 WASD+SPACE  P2 arrows+ENTER  X/BKSP let go  TAB cam P${this.followIndex + 1}\nE market  I bag  1-4 / 7-0 emote  M ${sound}  ESC menu`;
    this.hud.setText(controls);
    this.score.setTop(this.hud.y + this.hud.height + 6);
    const fisher = this.fishers[this.followIndex];
    const near = this.spotNear(cam);
    const atStall = !fisher.busy && this.nearShop(cam) && !this.shop.isOpen;
    const me = this.mode === 'online' ? this.myInfo() : null;
    const portal = !fisher.busy && !this.shop.isOpen && me?.seat !== 'passenger' ? portalAt(this.map, cam.x, cam.y, 4) : null;
    const mate = this.mode === 'online' && !fisher.busy ? this.boardable() : null;
    const seatHint = me?.seat === 'passenger' ? 'B: Leave boat   V: Switch seat' : me?.seat === 'driver' ? 'V: Switch seat' : mate ? `B: Board ${mate.baseName}'s boat` : '';
    const flash = this.time.now < (this.flashUntil ?? 0) ? this.flashText : '';
    const idle = this.map.movement !== 'boat' ? 'Walk to a glowing fishing spot'
      : me?.seat === 'passenger' ? 'Passenger: WASD to look around, fish when the boat is stopped'
        : this.players[0].held ? 'The boat holds still while your passenger fishes'
          : 'Sail into a ringed fishing zone';
    // Next to the boat you may also be at a fishing spot: show both options instead of hiding the boat.
    const sail = [portal ? `B: ${portal.label}` : '', seatHint].filter(Boolean).join('   ');
    const base = fisher.hint || (atStall ? 'Press E: market (sell fish, buy gear)' : near ? '' : idle);
    this.hint.setText(flash || (this.mode === 'online' && (this.randomFx.duelHint((pid) => this.nameOf(pid), this.time.now) || this.tiltHint() || this.angerHint() || this.randomFx.hint(this.players[0], this.map.id, this.time.now) || this.stealHint() || this.swimHint() || this.photoHint())) || (sail && fisher.state === 'idle' ? (base && near ? `${base}   |   ${sail}` : sail) : base));
    this.hint.setVisible(this.hint.text !== '');
  }

  /** Announce another player's rare catch. `id` is unique per catch, so duplicates are dropped. */
  showRare(e) {
    const species = speciesData.find((f) => f.id === e.speciesId);
    if (species && this.toast.show({ key: `${e.pid}:${e.id}`, name: e.name }, species, e.weight)) this.sfx?.play('rare');
  }

  /** A quick reaction bubble over a local player; online it is also sent to the other player. */
  sendEmote(who, id) {
    const player = this.players[who];
    if (!player || this.shop.isOpen || this.time.now < this.emoteReadyAt[who]) return;
    this.emoteReadyAt[who] = this.time.now + 1200;
    this.emotes.show(player, id);
    this.sfx?.play('emote');
    if (this.mode === 'online') this.net.emote(id);
  }

  /** The fishing spot this player is standing at, if any. */
  spotNear(player) {
    return this.zones.find((z) => z.contains(player.x, player.y)) ?? this.spots.find((s) => s.distanceTo(player.x, player.y) <= SPOT_RADIUS) ?? null;
  }

  // Throttled to NET_SEND_HZ and only when something changed; the server validates every update.
  sendState(dt) {
    this.sendAcc += dt;
    if (this.sendAcc < 1 / NET_SEND_HZ) return;
    this.sendAcc = 0;
    const p = this.players[0];
    const state = { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100, facing: p.facing, moving: p.moving || p.leaning };
    const l = this.lastSent;
    if (l && l.x === state.x && l.y === state.y && l.facing === state.facing && l.moving === state.moving) return;
    this.lastSent = state;
    this.net.sendState({ ...state, t: performance.now() });
  }

  /** The open ocean: animated sea, islands, rocks, the harbour pier and the portal back to the lake. */
  buildOcean() {
    const m = this.map;
    // The sea is three tilemap layers, one per animation frame of the A8 water tile; only one shows at a time.
    const cols = Math.ceil(m.width / TILE_SIZE);
    const rows = Math.ceil(m.height / TILE_SIZE);
    this.waterTiles = [0, 1, 2].map((f) => {
      const data = Array.from({ length: rows }, () => new Array(cols).fill(f));
      const tilemap = this.make.tilemap({ data, tileWidth: TILE_SIZE, tileHeight: TILE_SIZE });
      return tilemap.createLayer(0, tilemap.addTilesetImage(TEXTURES.OCEAN_WATER), 0, 0).setDepth(-100).setVisible(f === 0);
    });
    const theme = m.theme ?? {};
    this.add.rectangle(0, 0, m.width, m.height, theme.tint ?? 0x1f7fc4, theme.tintAlpha ?? 0.38).setOrigin(0).setDepth(-99); // calms the busy wave pattern
    this.waterClock = 0;
    this.waterFrame = 0;

    const rng = new Phaser.Math.RandomDataGenerator([theme.seed ?? 'open-ocean']); // seeded: every client draws the same islands
    const g = this.add.graphics().setDepth(-95);
    for (const land of m.land) {
      if (land.name === 'harbour pier') continue;
      g.fillStyle(theme.beach ?? 0xe6c98a, 1).fillRoundedRect(land.x - 3, land.y - 3, land.w + 6, land.h + 6, 12); // beach
      g.fillStyle(theme.grass ?? 0xcbd35f, 1).fillRoundedRect(land.x + 3, land.y + 3, land.w - 6, land.h - 6, 8); // grass
      const trees = theme.trees ?? Math.max(1, Math.round((land.w * land.h) / 6500));
      for (let i = 0; i < trees; i++) {
        const x = rng.between(land.x + 24, land.x + land.w - 24);
        const y = rng.between(land.y + 34, land.y + land.h - 8);
        this.add.image(x, y, TEXTURES.PROP_TREE).setOrigin(0.5, 1).setDepth(y);
      }
      for (let i = 0; i < trees * 2; i++) {
        this.add.image(rng.between(land.x + 8, land.x + land.w - 8), rng.between(land.y + 10, land.y + land.h - 4), TEXTURES.PROP_GRASS).setOrigin(0.5).setDepth(-90);
      }
    }
    for (const r of m.solids) this.add.image(r.x + r.w / 2, r.y + r.h, TEXTURES.PROP_ROCK).setOrigin(0.5, 1).setDepth(r.y + r.h);

    const pier = m.land.find((l) => l.name === 'harbour pier');
    if (pier) {
      for (let x = pier.x; x < pier.x + pier.w; x += TILE_SIZE) {
        for (let y = pier.y; y < pier.y + pier.h; y += TILE_SIZE) this.add.image(x, y, TEXTURES.DOCK_PLANK).setOrigin(0).setDepth(-80);
      }
    }
    for (const p of m.portals) {
      this.add.circle(p.x, p.y, p.radius, 0xffffff, 0.06).setStrokeStyle(1, 0xffffff, 0.3).setDepth(-70);
      const y = p.id === 'ocean_harbor' && pier ? pier.y - 2 : p.y - p.radius - 2;
      this.portalLabels ??= new Map();
      this.portalLabels.set(p.id, this.add
        .text(p.x, y, p.tag ?? 'PORT', { fontFamily: 'monospace', fontSize: '8px', color: '#ffffff', stroke: '#000000', strokeThickness: 2 })
        .setOrigin(0.5, 1).setResolution(4).setDepth(y));
    }
  }

  updateWater(dt) {
    this.waterClock += dt;
    const frame = Math.floor(this.waterClock * 3) % 3;
    if (frame !== this.waterFrame) {
      this.waterTiles[this.waterFrame].setVisible(false);
      this.waterTiles[frame].setVisible(true);
      this.waterFrame = frame;
    }
  }

  /** The duel arena: a small boxing ring on the lake shore. Duels (U) are fought inside it; everyone can walk through it otherwise. */
  buildArena() {
    const r = duelData.ring;
    if (!r) return;
    const floor = this.add.graphics().setDepth(-85);
    floor.fillStyle(0x5b3a2a, 1).fillRect(r.x - 3, r.y - 3, r.w + 6, r.h + 6); // the apron
    floor.fillStyle(0xd9c28a, 1).fillRect(r.x, r.y, r.w, r.h); // the canvas
    floor.lineStyle(1, 0xb89f63, 1).strokeRect(r.x + 10, r.y + 10, r.w - 20, r.h - 20);
    floor.fillStyle(0xb94a48, 0.55).fillRect(r.x + r.w / 2 - 2, r.y + 4, 4, r.h - 8); // centre line
    const colours = [0xffffff, 0xff6b6b, 0x7fd1ff];
    const back = this.add.graphics().setDepth(r.y);
    const front = this.add.graphics().setDepth(r.y + r.h + 3);
    colours.forEach((c, i) => {
      const dy = 6 + i * 5;
      back.lineStyle(2, c, 1).lineBetween(r.x, r.y - 10 + dy - 6, r.x + r.w, r.y - 10 + dy - 6);
      front.lineStyle(2, c, 1).lineBetween(r.x, r.y + r.h - 6 + dy - 6, r.x + r.w, r.y + r.h - 6 + dy - 6);
    });
    for (const [x, y] of [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]]) {
      this.add.rectangle(x, y, 5, 18, 0x4a4f5c).setOrigin(0.5, 1).setDepth(y + 4).setStrokeStyle(1, 0x20242c);
      this.add.circle(x, y - 18, 3, 0xff6b6b).setDepth(y + 5);
    }
    this.add
      .text(r.x + r.w / 2, r.y - 16, 'ARENA  (U: duel)', { fontFamily: 'monospace', fontSize: '8px', color: '#ffffff', stroke: '#000000', strokeThickness: 2 })
      .setOrigin(0.5, 1).setResolution(4).setDepth(r.y);
  }

  /** The boat tied up beside the pier: stand next to it and press B. */
  buildMooredBoat() {
    const { x, y } = LAKE_MAP.boat;
    new Boat(this, x, y, 'up');
    this.boatLabel = this.add
      .text(x, y - 22, 'SAIL (B)', { fontFamily: 'monospace', fontSize: '8px', color: '#ffffff', stroke: '#000000', strokeThickness: 2 })
      .setOrigin(0.5, 1).setResolution(4).setDepth(y);
  }

  buildGround() {
    const data = Array.from({ length: MAP_ROWS }, () => new Array(MAP_COLS).fill(GRASS_FRAME));
    const f = LAKE_FRAMES;
    const x1 = LAKE.x + LAKE.w - 1;
    const y1 = LAKE.y + LAKE.h - 1;
    for (let y = LAKE.y; y <= y1; y++) {
      for (let x = LAKE.x; x <= x1; x++) {
        const rowFrames = y === LAKE.y ? [f.tl, f.t, f.tr] : y === y1 ? [f.bl, f.b, f.br] : [f.l, f.c, f.r];
        data[y][x] = rowFrames[x === LAKE.x ? 0 : x === x1 ? 2 : 1];
      }
    }
    const map = this.make.tilemap({ data, tileWidth: TILE_SIZE, tileHeight: TILE_SIZE });
    const tileset = map.addTilesetImage(TEXTURES.WATER_GRASS);
    map.createLayer(0, tileset, 0, 0).setDepth(-100);

    // Grass tufts: seeded so every client (and every reload) sees the same meadow.
    const rng = new Phaser.Math.RandomDataGenerator(['sunset-lake']);
    for (let i = 0; i < 70; i++) {
      const x = rng.between(0, MAP_COLS - 1) * TILE_SIZE;
      const y = rng.between(0, MAP_ROWS - 1) * TILE_SIZE;
      const inLake = x >= (LAKE.x - 1) * TILE_SIZE && x <= (x1 + 1) * TILE_SIZE && y >= (LAKE.y - 1) * TILE_SIZE && y <= (y1 + 1) * TILE_SIZE;
      if (!inLake) this.add.image(x, y, TEXTURES.PROP_GRASS).setOrigin(0).setDepth(-90);
    }
  }

  buildDock() {
    for (let row = DOCK.rowTop; row <= DOCK.rowBottom; row++) {
      for (let c = 0; c < DOCK.cols; c++) {
        this.add.image((DOCK.col + c) * TILE_SIZE, row * TILE_SIZE, TEXTURES.DOCK_PLANK).setOrigin(0).setDepth(-80);
      }
    }
  }

  buildProps() {
    for (const p of PROPS) {
      this.add.image(p.x, p.y, PROP_TEXTURES[p.key]).setOrigin(0.5, 1).setDepth(p.y);
    }
    this.stallLabel = this.add
      .text(SHOP.x, SHOP.y - 42, 'MARKET', { fontFamily: 'monospace', fontSize: '8px', color: '#ffffff', stroke: '#000000', strokeThickness: 2 })
      .setOrigin(0.5, 1).setResolution(4).setDepth(SHOP.y + 1);
  }

  // A6 VFX: a few slow ripples so the lake does not look dead.
  buildRipples() {
    const spots = [[190, 140], [250, 260], [420, 200], [470, 290], [370, 120], [180, 300]];
    spots.forEach(([x, y], i) => {
      const s = this.add.sprite(x, y, TEXTURES.VFX_CALM_RIPPLE).setAlpha(0.55).setDepth(-70);
      s.play({ key: TEXTURES.VFX_CALM_RIPPLE, startFrame: (i * 5) % 16 });
    });
  }
}
