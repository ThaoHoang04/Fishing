import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { io as connect } from 'socket.io-client';
import { createGameServer } from '../server/index.js';
import { ReelSim, reelParams, TICK_RATE, REEL } from '../src/systems/ReelSim.js';

const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const BEHAVIOURS = { ...readJson('../src/data/behaviours.json'), ...readJson('../src/data/coopBehaviours.json') };
const BOSS = readJson('../src/data/bosses.json')[0];
const FISH = readJson('../src/data/fish.json');
const spots = readJson('../src/data/spots.json');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const MS = 1000 / TICK_RATE;

// ---------------- the simulation ----------------

const mid = { reelPower: 14, lineStrength: 1, maxWeight: 200 };
/** Two attentive players: the reeler reels while the fish rests, the easer relaxes the line when it is tight; they swap at each stage. */
function duoFight(seed, { react = 15, easeAt = 45, reelMax = 75, gear = mid, easers = true } = {}) {
  const sim = new ReelSim(reelParams(BOSS, BEHAVIOURS, gear, 100), seed);
  const hist = [];
  const stages = new Set();
  while (!sim.done) {
    hist.push({ phase: sim.phase, tension: sim.tension });
    const o = hist[Math.max(0, hist.length - 1 - react)];
    stages.add(sim.stage);
    sim.step(o.phase === 'rest' && o.tension < reelMax, easers && o.tension > easeAt);
  }
  return { outcome: sim.outcome, stages: stages.size, time: sim.time };
}
const winRate = (opts, n = 150) => {
  let w = 0;
  for (let s = 1; s <= n; s++) if (duoFight(s, opts).outcome === 'caught') w++;
  return w / n;
};

test('co-op boss data: a legendary boss with a stage-based behaviour of its own', () => {
  assert.equal(BOSS.boss, true);
  assert.equal(BOSS.coop, true);
  assert.equal(BOSS.rarity, 'legendary');
  assert.ok(!FISH.some((f) => f.id === BOSS.id), 'not a FishDex species: it is only ever met at a boss spot');
  const b = BEHAVIOURS.coopboss;
  assert.equal(b.stages.length, 3, 'steady, dashing, rage');
  assert.deepEqual(b.stages.map((s) => s.at), [0, 20, 40]);
  for (let i = 1; i < b.stages.length; i++) {
    assert.ok(b.stages[i].rise >= b.stages[i - 1].rise && b.stages[i].rest <= b.stages[i - 1].rest, 'every stage is harder than the last');
  }
});

test('solo fights are untouched by stages and easing (a fish with no `stages` and no easing plays exactly as before)', () => {
  const params = reelParams(FISH[0], BEHAVIOURS, mid, 1);
  assert.equal(params.stages, undefined);
  const a = new ReelSim(params, 99);
  const b = new ReelSim(params, 99);
  for (let i = 0; i < 400; i++) {
    a.step(i % 90 < 50);
    b.step(i % 90 < 50, false);
  }
  assert.deepEqual([a.distance, a.tension, a.phase], [b.distance, b.tension, b.phase]);
  assert.equal(a.stage, 0);
});

test('easing relaxes the line on top of whatever the reeler does', () => {
  const sim = new ReelSim(reelParams(BOSS, BEHAVIOURS, mid, 100), 1);
  sim.tension = 60;
  const before = sim.tension;
  sim.step(false, true);
  const noEase = new ReelSim(reelParams(BOSS, BEHAVIOURS, mid, 100), 1);
  noEase.tension = 60;
  noEase.step(false, false);
  assert.ok(sim.tension < noEase.tension - 0.4, `${sim.tension} vs ${noEase.tension}`);
  assert.ok(sim.tension < before);
});

test('the fight is built for two: a good pair wins, a pair on basic gear mostly does not, one player alone cannot', () => {
  const attentive = winRate({});
  const slow = winRate({ react: 30 });
  const verySlow = winRate({ react: 45 });
  const basic = winRate({ gear: { reelPower: 10, lineStrength: 1, maxWeight: 200 } });
  const best = winRate({ gear: { reelPower: 20, lineStrength: 1.6, maxWeight: 200 } });
  const alone = winRate({ easers: false });
  assert.ok(attentive >= 0.7 && attentive < 1, `attentive ${attentive}`);
  assert.ok(slow >= 0.4, `slow ${slow}`);
  assert.ok(verySlow < attentive, `very slow ${verySlow}`);
  assert.ok(basic <= 0.25, `basic gear ${basic}`);
  assert.ok(best >= 0.9, `best gear ${best}`);
  assert.ok(alone === 0, `without an easer ${alone}`);
  assert.ok(Math.max(...Array.from({ length: 30 }, (_, i) => duoFight(i + 1).stages)) === 3, 'a fight can reach the rage stage');
});

// ---------------- the server ----------------

let server;
let rngSeed = 3;
const rng = () => ((rngSeed = (rngSeed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const sockets = [];
before(async () => {
  server = await createGameServer({
    port: 0, graceMs: 200, world: false, rng,
    boss: { autoTick: false, coins: 300, lifeMs: 60_000 },
    fishing: { BITE_MIN_MS: 30, BITE_MAX_MS: 30, HOOK_MIN_MS: 600, HOOK_MAX_MS: 600, HOOK_SLACK_MS: 300, COOP_JOIN_MS: 400 },
  });
});
after(async () => {
  sockets.forEach((s) => s.disconnect());
  await server.close();
});

async function client() {
  const s = connect(`http://localhost:${server.port}`, { transports: ['websocket'], forceNew: true });
  sockets.push(s);
  s.request = (event, payload) => new Promise((r) => s.emit(event, payload, r));
  s.got = [];
  s.onAny((ev, d) => s.got.push([ev, d]));
  s.next = (event, pred = () => true, ms = 3000) => new Promise((resolve, reject) => {
    const hit = s.got.findIndex(([ev, d]) => ev === event && pred(d));
    if (hit !== -1) return resolve(s.got.splice(hit, 1)[0][1]);
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    const h = (d) => { if (pred(d)) { clearTimeout(t); s.off(event, h); resolve(d); } };
    s.on(event, h);
  });
  await new Promise((r) => s.on('connect', r));
  return s;
}

async function duo() {
  const a = await client();
  const b = await client();
  const ha = await a.request('profile:hello', { name: 'Ann' });
  const hb = await b.request('profile:hello', { name: 'Ben' });
  const created = await a.request('room:create', { name: 'Ann' });
  const joined = await b.request('room:join', { code: created.room.code, name: 'Ben' });
  const playing = new Promise((r) => a.on('room:state', (s) => s.phase === 'playing' && r()));
  a.emit('room:ready', true);
  b.emit('room:ready', true);
  await playing;
  const room = server.rooms.rooms.get(created.room.code);
  const find = (pid) => room.players.find((p) => p.pid === pid);
  const west = spots.find((x) => x.id === 'west');
  const mk = (sock, pid, profile) => ({ sock, pid, profileId: profile.profile.id, me: () => find(pid), put(x, y) { Object.assign(find(pid), { x, y }); } });
  const A = mk(a, created.pid, ha);
  const B = mk(b, joined.pid, hb);
  A.put(west.x, west.y);
  B.put(west.x - 10, west.y);
  return { A, B, room, west };
}

/** Cast at the boss's spot, wait for the bite, hook it. Resolves the 'coophook' event. */
async function hookBoss(P) {
  const cast = await P.sock.request('fishing:cast', { spotId: 'west', power: 0.5 });
  assert.equal(cast.ok, true, JSON.stringify(cast));
  await P.sock.next('fishing:event', (e) => e.event === 'bite');
  const hooked = P.sock.next('fishing:event', (e) => e.event === 'coophook');
  assert.deepEqual(await P.sock.request('fishing:hook', { id: cast.session.id }), { ok: true });
  return hooked;
}

const hold = (P, held) => P.sock.emit('boss:input', { held });

test('the boss spot is announced to the room and shows in the room state; only casts there bring up the boss', async () => {
  const { A, B, room } = await duo();
  const heard = B.sock.next('boss:spot');
  const view = A.sock.next('room:state', (s) => s.boss?.spotId === 'west');
  assert.equal(server.bossFights.spawn(room, 'west'), true);
  assert.deepEqual(await heard, { spotId: 'west', speciesId: 'ancient_catfish', name: 'Ancient Catfish', giant: false, lifeMs: 60000 });
  const state = await view;
  assert.equal(state.boss.name, 'Ancient Catfish');
  assert.ok(state.boss.remainingMs > 0 && state.boss.remainingMs <= 60000);
  assert.equal(server.bossFights.spawn(room, 'east'), false, 'one boss at a time');

  assert.ok(server.bossFights.forced(A.me(), 'west'));
  assert.equal(server.bossFights.forced(A.me(), 'east'), null, 'another spot is just a spot');
  const forced = server.bossFights.forced(A.me(), 'west');
  assert.ok(forced.weight >= BOSS.minWeight && forced.weight <= BOSS.maxWeight);
});

test('one hook alone does nothing: the partner is told, and if nobody joins the boss slips away', async () => {
  const { A, B, room } = await duo();
  server.bossFights.spawn(room, 'west');
  const told = B.sock.next('boss:hooked');
  const hooked = await hookBoss(A);
  assert.equal(hooked.speciesId, 'ancient_catfish');
  assert.equal(hooked.joinMs, 400);
  assert.equal((await told).pid, A.pid);
  assert.equal(room.fight ?? null, null, 'no fight yet');
  assert.equal(server.fishing.get(A.pid).state, 'coop');
  const lost = await A.sock.next('fishing:event', (e) => e.event === 'fail' && e.reason === 'alone');
  assert.ok(lost.id);
  assert.equal(server.fishing.get(A.pid), null, 'the line is free again');
  assert.deepEqual(await A.sock.request('fishing:finish', { id: lost.id, toggles: [] }), { ok: false, error: 'NO_SESSION' });
});

test('both hooked: the fight starts on the server, both stand still, both get the roles; a bad client cannot finish it for them', async () => {
  const { A, B, room } = await duo();
  server.bossFights.spawn(room, 'west');
  const startsA = A.sock.next('boss:fight');
  const startsB = B.sock.next('boss:fight');
  const hookedA = await hookBoss(A);
  await hookBoss(B);
  const fa = await startsA;
  const fb = await startsB;
  assert.deepEqual(fa, fb);
  assert.deepEqual(fa.roles, { reel: A.pid, ease: B.pid }, 'the first to hook reels, the second eases');
  assert.equal(fa.name, 'Ancient Catfish');
  assert.equal(fa.maxDistance, REEL.MAX_DISTANCE);
  assert.deepEqual(fa.stages.map((s) => s.label), ['Steady', 'Dashing', 'RAGE']);
  assert.ok(room.fight);
  for (const P of [A, B]) assert.ok(P.me().stunnedUntil > 1e12, 'frozen for the fight');
  assert.equal((await A.sock.request('fishing:finish', { id: hookedA.id, toggles: [10, 20] })).ok, false, 'the client cannot finish a co-op fight');
  assert.equal((await A.sock.request('fishing:cast', { spotId: 'west', power: 0.5 })).ok, false);
  const snap = await A.sock.next('boss:state');
  assert.ok(snap.distance > 0 && snap.tension === 0 && snap.phase === 'rest');
  server.bossFights.cancelFor(A.me());
  await B.sock.next('boss:result', (r) => r.outcome === 'cancelled');
  assert.equal(room.fight, null);
  assert.equal(B.me().stunnedUntil, 0);
});

/** Play the fight on the server with a fake clock: the reeler holds while the fish rests, the easer while the line is tight. */
function playOut(room, A, B, { good = true } = {}) {
  const fight = room.fight;
  const players = { [A.pid]: A, [B.pid]: B };
  let now = fight.last;
  const swapped = [];
  let lastRoles = { ...fight.roles };
  for (let i = 0; i < 60 * 120 && room.fight === fight; i++) {
    const s = fight.sim;
    const reelHeld = good ? s.phase === 'rest' && s.tension < 70 : true; // a masher holds reel all the time
    const easeHeld = good ? s.tension > 40 : false;
    // feed the held flags straight to the server (the socket handler calls the same method)
    server.bossFights.input(players[fight.roles.reel].me(), reelHeld);
    server.bossFights.input(players[fight.roles.ease].me(), easeHeld);
    now += MS;
    server.bossFights.tick(now);
    if (fight.roles.reel !== lastRoles.reel) { swapped.push(fight.stage); lastRoles = { ...fight.roles }; }
  }
  return swapped;
}

test('a won fight: both players get the boss fish, the bounty and credit; the roles swap at each stage; the boss is gone', async () => {
  const { A, B, room } = await duo();
  server.bossFights.spawn(room, 'west');
  const starts = A.sock.next('boss:fight');
  await hookBoss(A);
  await hookBoss(B);
  await starts;
  const resA = A.sock.next('boss:result', () => true, 8000);
  const resB = B.sock.next('boss:result', () => true, 8000);
  const gone = B.sock.next('boss:gone', () => true, 8000);
  // the fish is almost in: the reeler holds, and it is landed (the fight itself is covered by the simulation tests above)
  room.fight.sim.distance = 3;
  server.bossFights.input(A.me(), true);
  let now = room.fight.last;
  for (let i = 0; i < 120 && room.fight; i++) { now += MS; server.bossFights.tick(now); }
  const result = await resA;
  assert.equal(result.outcome, 'caught');
  assert.equal((await resB).outcome, 'caught');
  assert.equal(result.coins, 300);
  assert.equal(result.name, 'Ancient Catfish');
  assert.deepEqual(Object.keys(result.fish).sort(), [A.pid, B.pid].sort());
  for (const P of [A, B]) {
    const state = server.economy.state(P.profileId);
    assert.equal(state.coin, 300, 'the bounty');
    assert.equal(state.items.filter((i) => i.speciesId === 'ancient_catfish').length, 1, 'and the fish');
    assert.equal(P.me().stunnedUntil, 0, 'free again');
    assert.equal(P.me().stats.caught, 1, 'on the scoreboard');
    assert.equal(server.fishing.get(P.pid), null);
  }
  assert.equal((await gone).caught, true);
  assert.equal(room.bossSpot, null);
  assert.equal(room.fight, null);
  assert.equal(server.bossFights.forced(A.me(), 'west'), null);
}, { timeout: 30000 });

test('a lost fight (a masher holding reel all the time snaps the line): nothing awarded, lines free, the boss waits for another try', async () => {
  const { A, B, room } = await duo();
  server.bossFights.spawn(room, 'west');
  const starts = A.sock.next('boss:fight');
  await hookBoss(A);
  await hookBoss(B);
  await starts;
  const res = A.sock.next('boss:result', () => true, 8000);
  playOut(room, A, B, { good: false });
  const r = await res;
  assert.notEqual(r.outcome, 'caught');
  assert.equal(r.coins, 0);
  for (const P of [A, B]) {
    assert.equal(server.economy.state(P.profileId).items.length, 0);
    assert.equal(server.economy.state(P.profileId).coin, 0);
    assert.equal(P.me().stunnedUntil, 0);
    assert.equal(server.fishing.get(P.pid), null);
  }
  assert.ok(room.bossSpot, 'still there: try again');
  assert.ok(server.bossFights.forced(A.me(), 'west'));
}, { timeout: 30000 });

test('the roles swap when a harder stage begins, and the buttons follow the new roles', async () => {
  const { A, B, room } = await duo();
  server.bossFights.spawn(room, 'west');
  await hookBoss(A);
  await hookBoss(B);
  await wait(50);
  const fight = room.fight;
  const seen = [];
  A.sock.on('boss:roles', (r) => seen.push(r));
  let now = fight.last;
  // idle fight: nobody touches anything for 21 seconds -> stage 1 begins (the fish drifts away, so this may even end it first)
  fight.sim.p = { ...fight.sim.p, drift: 0, pullDrift: 0 }; // keep it alive for the test
  for (let i = 0; i < 60 * 21 && room.fight === fight; i++) { now += MS; server.bossFights.tick(now); }
  await wait(100);
  assert.equal(fight.stage, 1);
  assert.deepEqual(fight.roles, { reel: B.pid, ease: A.pid }, 'swapped');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].label, 'Dashing');
  // B (now the reeler) holds: that reels the distance down; A's button is the easer now
  server.bossFights.input(B.me(), true);
  const d0 = fight.sim.distance;
  for (let i = 0; i < 30; i++) { now += MS; server.bossFights.tick(now); }
  assert.ok(fight.sim.distance < d0, 'the new reeler reels');
  server.bossFights.input(B.me(), false);
  server.bossFights.input(A.me(), true);
  const t0 = fight.sim.tension;
  for (let i = 0; i < 20; i++) { now += MS; server.bossFights.tick(now); }
  assert.ok(fight.sim.tension <= t0, 'the new easer relaxes the line');
  server.bossFights.cancelFor(A.me());
});

test('boss packets from strangers and bad input are ignored; the scheduler only runs with random events on', async () => {
  const { A, B, room } = await duo();
  assert.equal(server.bossFights.input(A.me(), true), false, 'no fight');
  const outsider = await client();
  outsider.emit('boss:input', { held: true });
  outsider.emit('boss:input', null);
  A.sock.emit('boss:input');
  await wait(50);
  assert.equal(room.bossPlan, undefined, 'no scheduling when the random events are off');
  server.bossFights.spawn(room, 'west');
  await hookBoss(A);
  await hookBoss(B);
  await wait(50);
  A.sock.emit('boss:input', { held: 'yes' });
  await wait(50);
  assert.equal(room.fight.held[A.pid], true, 'truthy values are just "held"');
  server.bossFights.cancelFor(B.me());
});

test('every co-op boss has its own stage behaviour, no FishDex entry, and a scheduled boss can be any of them', () => {
  const bosses = readJson('../src/data/bosses.json');
  assert.ok(bosses.length >= 3);
  assert.equal(new Set(bosses.map((b) => b.id)).size, bosses.length);
  for (const b of bosses) {
    assert.equal(b.coop, true);
    assert.ok(BEHAVIOURS[b.behaviour]?.stages?.length === 3, `${b.id} has stages`);
    assert.ok(!FISH.some((f) => f.id === b.id));
  }
});

test('giant fish: heavy ordinary fish that need two, gentler than the bosses, with a smaller bounty and more frequent spawns', () => {
  const bosses = readJson('../src/data/bosses.json');
  const giants = bosses.filter((b) => b.giant);
  const real = bosses.filter((b) => !b.giant);
  assert.ok(giants.length >= 2 && real.length >= 3);
  for (const g of giants) {
    assert.equal(g.coop, true);
    assert.ok(g.minWeight >= 40, 'really heavy');
    assert.ok(g.bounty > 0 && g.bounty < 300, 'smaller than the boss bounty');
    assert.ok(g.weight > Math.max(...real.map((r) => r.weight ?? 1)), 'seen more often than a boss');
    const b = BEHAVIOURS[g.behaviour];
    assert.ok(b.pullRise < BEHAVIOURS.coopboss.pullRise && b.restMin >= BEHAVIOURS.coopboss.restMin, 'gentler');
  }
});
