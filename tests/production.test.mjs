import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import http from 'node:http';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io as connect } from 'socket.io-client';
import { createGameServer } from '../server/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(ROOT, 'dist');
const built = existsSync(path.join(dist, 'index.html'));
const skip = built ? false : 'run `npm run build` first (the production build is what is being tested)';

let server;
before(async () => {
  if (built) server = await createGameServer({ port: 0 });
});
after(async () => {
  await server?.close();
});

const get = (urlPath, headers = {}) =>
  new Promise((resolve, reject) => {
    http.get({ port: server.port, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });

test('the server serves the built game and a health check', { skip }, async () => {
  const page = await get('/');
  assert.equal(page.status, 200);
  assert.match(page.body.toString(), /<title>Fishing Together<\/title>/);
  assert.match(page.body.toString(), /id="lobby"/);
  assert.equal(page.headers['cache-control'], 'no-cache', 'the page itself is never stale');
  assert.equal(page.headers['x-powered-by'], undefined);

  const health = await get('/health');
  assert.deepEqual(JSON.parse(health.body.toString()), { ok: true, rooms: 0 });
  assert.equal((await get('/nope.js')).status, 404);
});

test('JavaScript is cached forever (fingerprinted) and gzipped on the wire', { skip }, async () => {
  const files = readdirSync(path.join(dist, 'assets')).filter((f) => f.endsWith('.js'));
  const phaser = files.find((f) => f.startsWith('phaser-'));
  const game = files.find((f) => f.startsWith('index-'));
  assert.ok(phaser && game, 'Phaser is its own chunk, separate from the game code');

  const raw = await get(`/assets/${phaser}`, { 'Accept-Encoding': 'identity' });
  const zipped = await get(`/assets/${phaser}`, { 'Accept-Encoding': 'gzip' });
  assert.equal(zipped.headers['content-encoding'], 'gzip');
  assert.match(zipped.headers['cache-control'], /immutable/);
  assert.ok(zipped.body.length < raw.body.length * 0.35, `gzip ${zipped.body.length} vs ${raw.body.length}`);
  assert.equal(zlib.gunzipSync(zipped.body).length, raw.body.length, 'it decompresses to the same file');

  const gameJs = await get(`/assets/${game}`, { 'Accept-Encoding': 'gzip' });
  assert.ok(gameJs.body.length < 80 * 1024, `game code is ${gameJs.body.length} bytes over the wire`);
});

test('first load is small: total bytes over the wire for page + code + art', { skip }, async () => {
  const urls = ['/'];
  for (const f of readdirSync(path.join(dist, 'assets'), { recursive: true })) {
    if (/\.(js|png)$/.test(String(f))) urls.push(`/assets/${String(f).split(path.sep).join('/')}`);
  }
  let total = 0;
  for (const u of urls) total += (await get(u, { 'Accept-Encoding': 'gzip' })).body.length;
  assert.ok(total < 700 * 1024, `first load is ${Math.round(total / 1024)} KB over ${urls.length} requests`);
  assert.ok(urls.length <= 25, `${urls.length} requests`);
});

test('images are cached for an hour, and the game connects through the same server', { skip }, async () => {
  const png = await get('/assets/fish/fish_icons_16.png');
  assert.equal(png.status, 200);
  assert.match(png.headers['cache-control'], /max-age=3600/);

  const s = connect(`http://localhost:${server.port}`, { transports: ['websocket'], forceNew: true });
  const hello = await new Promise((resolve) => s.on('connect', () => s.emit('profile:hello', { name: 'Prod' }, resolve)));
  assert.equal(hello.ok, true);
  s.disconnect();
});
