import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { readFileSync } from 'node:fs';
import { createGameServer } from '../server/index.js';
import { sanitizeChat, allowChat, CHAT_MAX, CHAT_GAP_MS, CHAT_BURST, CHAT_BURST_MS } from '../src/systems/ChatRules.js';

const quick = JSON.parse(readFileSync(new URL('../src/data/quickchat.json', import.meta.url), 'utf8'));

// ---- rules ----

test('sanitizeChat: trims, collapses spaces, drops control and invisible characters, cuts at the limit', () => {
  assert.equal(sanitizeChat('  hello   world  '), 'hello world');
  assert.equal(sanitizeChat('a\u0000b​c\nd'), 'a b c d');
  assert.equal(sanitizeChat('Ê qua đây có cá to'), 'Ê qua đây có cá to', 'Vietnamese text is untouched');
  assert.equal(sanitizeChat('x'.repeat(500)).length, CHAT_MAX);
  assert.equal([...sanitizeChat('🐟'.repeat(300))].length, CHAT_MAX, 'counts characters, not UTF-16 units');
  for (const bad of ['', '   ', '\n\t', null, undefined, 5, {}, ['a']]) assert.equal(sanitizeChat(bad), '');
});

test('allowChat: a minimum gap and a burst limit, then recovers', () => {
  const times = [];
  assert.equal(allowChat(times, 1000), true);
  assert.equal(allowChat(times, 1000 + CHAT_GAP_MS - 1), false, 'too soon');
  let t = 1000;
  let sent = 1;
  while (allowChat(times, (t += CHAT_GAP_MS))) sent++;
  assert.equal(sent, CHAT_BURST, 'stops at the burst limit');
  assert.equal(allowChat(times, t + CHAT_BURST_MS + 1), true, 'allowed again once the window has passed');
});

test('quick chat phrases are valid messages', () => {
  assert.ok(quick.length >= 7);
  for (const phrase of quick) assert.equal(sanitizeChat(phrase), phrase);
});

// ---- server ----

let server;
let clock = 1_000_000;
const clients = [];
before(async () => {
  server = await createGameServer({ port: 0, world: false, now: () => clock });
});
after(async () => {
  clients.forEach((c) => c.disconnect());
  await server.close();
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function client() {
  const s = connect(`http://localhost:${server.port}`, { transports: ['websocket'], forceNew: true });
  clients.push(s);
  await new Promise((r) => s.on('connect', r));
  s.request = (event, payload) => new Promise((r) => s.emit(event, payload, r));
  return s;
}
async function startedRoom() {
  const a = await client();
  const b = await client();
  const created = await a.request('room:create', { name: 'Alice' });
  await b.request('room:join', { code: created.room.code, name: 'Bob' });
  const playing = new Promise((r) => a.on('room:state', (s) => s.phase === 'playing' && r()));
  a.emit('room:ready', true);
  b.emit('room:ready', true);
  await playing;
  return { a, b, created };
}

test('chat reaches both players (sender included), with name and slot, text cleaned', async () => {
  const { a, b, created } = await startedRoom();
  const toA = [];
  const toB = [];
  a.on('chat', (m) => toA.push(m));
  b.on('chat', (m) => toB.push(m));
  const res = await a.request('chat', { text: '  Ê   qua đây  ' });
  assert.deepEqual(res, { ok: true });
  await wait(100);
  const expected = { pid: created.pid, name: 'Alice', slot: 0, text: 'Ê qua đây' };
  assert.deepEqual(toA, [expected]);
  assert.deepEqual(toB, [expected]);
});

test('chat: long text is cut, junk is rejected, markup stays plain text', async () => {
  const { a, b } = await startedRoom();
  const got = [];
  b.on('chat', (m) => got.push(m));
  clock += 5000;
  assert.deepEqual(await a.request('chat', { text: 'y'.repeat(1000) }), { ok: true });
  for (const bad of [{ text: '' }, { text: '   ' }, { text: 42 }, {}, null, undefined]) {
    clock += 5000;
    const r = await a.request('chat', bad);
    assert.deepEqual(r, { ok: false, error: 'EMPTY' });
  }
  clock += 5000;
  await a.request('chat', { text: '<img src=x onerror=alert(1)>' });
  await wait(100);
  assert.equal(got[0].text.length, CHAT_MAX);
  assert.equal(got.length, 2, 'only the two real messages arrived');
  assert.equal(got[1].text, '<img src=x onerror=alert(1)>', 'sent as text; the client only ever uses text nodes');
});

test('chat: flood limited per player on the server clock, the other player is unaffected', async () => {
  const { a, b } = await startedRoom();
  clock += 60_000;
  assert.equal((await a.request('chat', { text: 'one' })).ok, true);
  assert.deepEqual(await a.request('chat', { text: 'two' }), { ok: false, error: 'TOO_FAST' });
  assert.equal((await b.request('chat', { text: 'mine' })).ok, true, 'the limit is per player');
  clock += CHAT_GAP_MS;
  assert.equal((await a.request('chat', { text: 'three' })).ok, true);
  let denied = 0;
  for (let i = 0; i < 12; i++) {
    clock += CHAT_GAP_MS;
    if (!(await a.request('chat', { text: `m${i}` })).ok) denied++;
  }
  assert.ok(denied > 0, 'a long stream hits the burst limit');
  clock += CHAT_BURST_MS + 1;
  assert.equal((await a.request('chat', { text: 'back' })).ok, true);
});

test('chat only works in a running game, and not across rooms', async () => {
  const a = await client();
  const created = await a.request('room:create', { name: 'Solo' });
  assert.deepEqual(await a.request('chat', { text: 'hi' }), { ok: false, error: 'NOT_PLAYING' });
  assert.equal(created.ok, true);
  const nobody = await client();
  assert.deepEqual(await nobody.request('chat', { text: 'hi' }), { ok: false, error: 'NOT_PLAYING' });

  const one = await startedRoom();
  const two = await startedRoom();
  const leaked = [];
  two.a.on('chat', (m) => leaked.push(m));
  two.b.on('chat', (m) => leaked.push(m));
  clock += 10_000;
  await one.a.request('chat', { text: 'private' });
  await wait(150);
  assert.equal(leaked.length, 0, 'another room never sees it');
});
