import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { io as connect } from 'socket.io-client';
import { createGameServer } from '../server/index.js';
import { TICK_RATE } from '../src/systems/ReelSim.js';
import { SHOP } from '../src/data/world.js';
import { INVENTORY_SLOTS } from '../src/systems/Economy.js';
import { play, bots, byId } from './bots.mjs';

// A long accelerated play session: two bots fish, sell, shop, emote, drop out and come back, hundreds of times.
// It checks what only goes wrong over time: coins that do not add up, an inventory over capacity, sessions or
// sockets that are never cleaned up, and errors that appear after the thousandth catch.

const spots = JSON.parse(readFileSync(new URL('../src/data/spots.json', import.meta.url), 'utf8')).filter((s) => !s.map || s.map === 'lake');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('soak: two bots play hundreds of rounds; money adds up, nothing leaks, nothing breaks', async (t) => {
  let skew = 0;
  let seed = 90210;
  const rng = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const server = await createGameServer({
    port: 0,
    world: false, // no weather: these tests script their own rolls
    graceMs: 120,
    now: () => Date.now() + skew,
    rng,
    fishing: { BITE_MIN_MS: 10, BITE_MAX_MS: 30, HOOK_MIN_MS: 800, HOOK_MAX_MS: 800, HOOK_SLACK_MS: 700 }, // generous: a loaded machine must not turn this into a flaky test
  });
  const sockets = [];
  t.after(async () => {
    sockets.forEach((s) => s.disconnect());
    await server.close();
  });
  const problems = [];
  const open = async () => {
    const s = connect(`http://localhost:${server.port}`, { transports: ['websocket'], forceNew: true });
    sockets.push(s);
    s.on('error', (e) => problems.push(`socket error ${e}`));
    // Events can share a packet with a request's ack; keep what arrives until the end of the tick that handles the ack.
    s.buffer = [];
    s.buffering = 0;
    s.onAny((ev, d) => s.buffering > 0 && s.buffer.push([ev, d]));
    s.request = (e, p) => new Promise((resolve, reject) => {
      s.buffer.length = 0;
      s.buffering++;
      const timer = setTimeout(() => { s.buffering--; reject(new Error(`${e} timed out`)); }, 5000);
      s.emit(e, p, (r) => {
        clearTimeout(timer);
        setImmediate(() => { s.buffering--; if (s.buffering === 0) s.buffer.length = 0; });
        resolve(r);
      });
    });
    await new Promise((r) => s.on('connect', r));
    return s;
  };
  const waitEvent = (s, ev, pred = () => true, ms = 4000) => new Promise((resolve, reject) => {
    const seen = s.buffer.findIndex(([e, d]) => e === ev && pred(d));
    if (seen !== -1) return resolve(s.buffer.splice(seen, 1)[0][1]);
    const timer = setTimeout(() => { s.off(ev, h); reject(new Error(`timeout: ${ev}`)); }, ms);
    const h = (d) => { if (pred(d)) { clearTimeout(timer); s.off(ev, h); resolve(d); } };
    s.on(ev, h);
  });

  // ---- a running room with two profiles
  const a = await open();
  const b = await open();
  const ha = await a.request('profile:hello', { name: 'Bot A', tab: 'a' });
  const hb = await b.request('profile:hello', { name: 'Bot B', tab: 'b' });
  const room = await a.request('room:create', { name: 'Bot A' });
  const joined = await b.request('room:join', { code: room.room.code, name: 'Bot B' });
  const playing = waitEvent(a, 'room:state', (st) => st.phase === 'playing');
  a.emit('room:ready', true);
  b.emit('room:ready', true);
  await playing;

  const players = [
    { sock: a, profileId: ha.profile.id, slot: 0, pid: room.pid, earned: 0, spent: 0, caught: 0, lost: 0 },
    { sock: b, profileId: hb.profile.id, slot: 1, pid: joined.pid, earned: 0, spent: 0, caught: 0, lost: 0 },
  ];
  const playerOf = (bot) => server.rooms.rooms.get(room.room.code).players.find((p) => p.pid === bot.pid);
  const goto = (bot, x, y) => { const p = playerOf(bot); p.x = x; p.y = y; };
  const state = (bot) => server.economy.state(bot.profileId);

  const ROUNDS = 90;
  const reactions = [100, 200, 300];

  async function round(bot, i) {
    const spot = spots[(i * 3 + bot.slot) % spots.length];
    goto(bot, spot.x, spot.y);
    const cast = await bot.sock.request('fishing:cast', { spotId: spot.id, power: (i % 10) / 10 });
    if (!cast.ok) {
      assert.equal(cast.error, 'INVENTORY_FULL', `unexpected cast failure at round ${i}: ${cast.error}`);
      return 'full';
    }
    await waitEvent(bot.sock, 'fishing:event', (e) => e.event === 'bite');
    const hooked = waitEvent(bot.sock, 'fishing:event', (e) => e.event === 'hooked');
    assert.equal((await bot.sock.request('fishing:hook', { id: cast.session.id })).ok, true);
    const h = await hooked;
    // Every third fight is played badly on purpose (holding the button), so losses are exercised too.
    const bad = i % 3 === 2;
    const fight = play(byId(h.speciesId), bad ? bots.masher : bots.fishWatcher(reactions[i % 3]), h.seed, h.gear, h.weight);
    skew += (fight.sim.tick / TICK_RATE) * 1000;
    const result = waitEvent(bot.sock, 'fishing:event', (e) => e.event === 'result');
    const ack = await bot.sock.request('fishing:finish', { id: cast.session.id, toggles: fight.toggles });
    const r = await result;
    assert.equal(ack.outcome, r.outcome);
    assert.equal(r.outcome, fight.sim.outcome, 'the server replay agrees with the client simulation');
    if (r.outcome === 'caught') bot.caught++;
    else bot.lost++;
    return r.outcome;
  }

  async function market(bot) {
    goto(bot, SHOP.talkX, SHOP.talkY);
    const sold = await bot.sock.request('inv:sellAll');
    if (sold.ok) bot.earned += sold.earned;
    else assert.equal(sold.error, 'NOTHING_TO_SELL');
    const owned = state(bot).owned;
    for (const id of ['rod_fiber', 'line_braided', 'bait_glow', 'rod_carbon', 'line_titanium', 'bait_golden'].filter((e) => !owned.includes(e))) {
      const r = await bot.sock.request('shop:buy', { id });
      if (r.ok) {
        bot.spent += r.price;
        await bot.sock.request('shop:equip', { id });
      } else assert.equal(r.error, 'NOT_ENOUGH_COIN');
    }
    assert.ok(state(bot).coin >= 0);
  }

  let rounds = 0;
  const started = Date.now();
  for (let i = 0; i < ROUNDS; i++) {
    await Promise.all(players.map((bot) => round(bot, i)));
    rounds += 2;
    if (i % 6 === 5) await Promise.all(players.map(market));
    if (i % 4 === 1) players[0].sock.emit('emote', { id: i % 4 });

    // Every 20 rounds bot B drops out mid-game and takes its slot back; no fishing line may be left behind.
    if (i % 20 === 19) {
      const bot = players[1];
      goto(bot, spots[0].x, spots[0].y);
      await bot.sock.request('fishing:cast', { spotId: spots[0].id, power: 0.5 }).catch(() => null);
      bot.sock.disconnect();
      await wait(40);
      assert.equal(server.fishing.get(bot.pid), null, 'a dropped player has no line out');
      const again = await open();
      await again.request('profile:hello', { id: hb.profile.id, token: hb.profile.token, tab: 'b' });
      const back = await again.request('room:rejoin', { code: room.room.code, token: joined.token });
      assert.equal(back.ok, true, `rejoin failed at round ${i}`);
      bot.sock = again;
    }
  }
  const seconds = (Date.now() - started) / 1000;

  // ---- bookkeeping: every coin and every fish is accounted for
  for (const bot of players) {
    const s = state(bot);
    assert.equal(s.coin, bot.earned - bot.spent, `slot ${bot.slot}: coins do not add up (earned ${bot.earned}, spent ${bot.spent})`);
    assert.ok(s.coin >= 0);
    assert.ok(s.items.length <= INVENTORY_SLOTS);
    const all = server.store.listCatches(bot.profileId);
    assert.equal(all.length, bot.caught, 'every landed fish is on record, nothing extra');
    assert.equal(all.filter((c) => !c.sold).length, s.items.length);
    for (const slot of ['rod', 'line', 'bait']) assert.ok(s.owned.includes(s.equipped[slot]));
  }
  assert.ok(players.every((p) => p.caught > 10 && p.lost > 5), `wins and losses were both exercised: ${JSON.stringify(players.map((p) => [p.caught, p.lost]))}`);
  assert.ok(players.some((p) => p.spent > 0), 'and some shopping happened');
  assert.deepEqual(server.rooms.rooms.get(room.room.code).players.map((p) => p.stats.caught), players.map((p) => p.caught), 'the scoreboard matches reality');
  assert.equal(server.stats().sessions, 0, 'no fishing session left behind');
  assert.deepEqual(problems, []);

  // ---- everyone leaves: the server's tables empty out
  for (const bot of players) await bot.sock.request('room:leave');
  await wait(300);
  assert.equal(server.stats().rooms, 0);
  assert.equal(server.stats().players, 0);
  sockets.forEach((s) => s.disconnect());
  await wait(200);
  assert.deepEqual(server.stats(), { rooms: 0, players: 0, bound: 0, sessions: 0 }, 'no profile binding survives its socket');
  t.diagnostic(`${rounds} fishing rounds in ${seconds.toFixed(1)}s (${players.map((p) => `${p.caught} caught / ${p.lost} lost`).join(', ')})`);
});

test('soak: a storm of joins, drops and rejoins never exceeds two players and never leaves rooms behind', async (t) => {
  const server = await createGameServer({ port: 0, world: false, graceMs: 60 });
  const sockets = [];
  t.after(async () => {
    sockets.forEach((s) => s.disconnect());
    await server.close();
  });
  const open = async () => {
    const s = connect(`http://localhost:${server.port}`, { transports: ['websocket'], forceNew: true });
    sockets.push(s);
    s.request = (e, p) => new Promise((r) => s.emit(e, p, r));
    await new Promise((r) => s.on('connect', r));
    return s;
  };
  let seed = 5;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const owner = await open();
  const created = await owner.request('room:create', { name: 'Owner' });
  let full = 0;
  let joinedOk = 0;
  for (let i = 0; i < 120; i++) {
    const guest = await open();
    const res = await guest.request('room:join', { code: created.room.code, name: `G${i}` });
    if (res.ok) {
      joinedOk++;
      assert.ok(server.rooms.rooms.get(created.room.code).players.length <= 2);
      if (rnd() < 0.5) await guest.request('room:leave');
      else guest.disconnect();
      await wait(rnd() < 0.3 ? 80 : 5); // sometimes past the grace period, sometimes not
    } else {
      assert.equal(res.error, 'ROOM_FULL');
      full++;
    }
    assert.ok(server.rooms.rooms.get(created.room.code).players.length <= 2, 'never more than two players');
  }
  assert.ok(joinedOk > 5 && full > 5, `both outcomes were exercised: joined ${joinedOk}, refused ${full}`);
  owner.disconnect();
  await wait(400);
  sockets.forEach((s) => s.disconnect());
  await wait(300);
  assert.deepEqual(server.stats(), { rooms: 0, players: 0, bound: 0, sessions: 0 }, 'the room and every slot were cleaned up');
});
