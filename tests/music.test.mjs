import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Sfx from '../src/audio/Sfx.js';
import Music from '../src/audio/Music.js';

const DATA = JSON.parse(readFileSync(new URL('../src/data/music.json', import.meta.url), 'utf8'));

// A recording stand-in for AudioContext (same idea as the audio tests): it remembers every note that gets scheduled.
function fakeContext() {
  const notes = []; // {freq, type, at}
  const gains = [];
  const param = (rec) => ({ value: 0, setValueAtTime(v, t) { rec?.push([v, t]); }, linearRampToValueAtTime(v, t) { rec?.push([v, t]); }, exponentialRampToValueAtTime() {} });
  const node = (extra = {}) => ({ connect() { return this; }, ...extra });
  const ctx = {
    state: 'running', currentTime: 0, sampleRate: 8000, destination: {}, notes, gains,
    resume() {},
    createGain() { const rec = []; gains.push(rec); return node({ gain: param(rec) }); },
    createOscillator() {
      const o = node({ type: 'sine', start() {}, stop() {} });
      o.frequency = { value: 0, setValueAtTime(f, t) { notes.push({ freq: f, type: o.type, at: t }); }, exponentialRampToValueAtTime() {} };
      return o;
    },
    createBiquadFilter() { return node({ frequency: param(), type: 'lowpass' }); },
    createBuffer(_c, len) { return { getChannelData: () => new Float32Array(len) }; },
    createBufferSource() { return node({ buffer: null, loop: false, start() {}, stop() {} }); },
  };
  return ctx;
}
const storage = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; };

/** A music player on a fake audio context and a hand-cranked timer: `run(seconds)` advances the clock in small steps. */
function rig() {
  const ctx = fakeContext();
  const sfx = new Sfx({ createContext: () => ctx, storage: storage() });
  const timers = [];
  const music = new Music(sfx, { config: DATA, setTimer: (fn, ms) => { const t = { fn, ms, on: true }; timers.push(t); return t; }, clearTimer: (t) => { t.on = false; } });
  const run = (seconds) => {
    for (let i = 0; i < Math.round(seconds / 0.1); i++) {
      ctx.currentTime += 0.1;
      for (const t of [...timers]) if (t.on) t.fn();
    }
  };
  return { ctx, sfx, music, run, timers };
}
const freqs = (ctx) => new Set(ctx.notes.map((n) => Math.round(n.freq)));

test('music data: every theme is a real tempo, key, scale, chords and patterns the player can read', () => {
  const ids = Object.keys(DATA.themes);
  assert.deepEqual(ids.sort(), ['boss', 'lake', 'night'], 'cozy lake, night fishing, boss fishing');
  for (const [id, t] of Object.entries(DATA.themes)) {
    assert.ok(t.bpm >= 50 && t.bpm <= 160, `${id} tempo`);
    assert.ok(Number.isInteger(t.root) && t.root >= 36 && t.root <= 72, `${id} key`);
    assert.ok(t.scale.length >= 5 && t.scale.every(Number.isInteger));
    assert.equal(t.chords.length, t.bass.length, `${id}: one bass note per chord`);
    for (const chord of t.chords) assert.ok(chord.length >= 3 && chord.every(Number.isInteger));
    assert.equal(t.bassPattern.length, 8);
    for (const m of t.melodies) assert.equal(m.length, 8, `${id} melody bars are 8 steps`);
    assert.ok(t.melodies.some((m) => m.some((d) => d !== null)));
    for (const v of ['pad', 'melody', 'bass']) assert.ok(['sine', 'triangle', 'square', 'sawtooth'].includes(t.voices[v]) && t.levels[v] > 0 && t.levels[v] < 0.2);
  }
  assert.ok(DATA.themes.boss.bpm > DATA.themes.lake.bpm && DATA.themes.night.bpm < DATA.themes.lake.bpm, 'the boss is fast, the night slow');
  assert.ok(DATA.volume > 0 && DATA.volume <= 1);
});

test('nothing plays before the first user gesture; asking for a theme early starts it as soon as the audio unlocks', () => {
  const { ctx, sfx, music, run } = rig();
  music.setTheme('lake');
  music.sync();
  run(1);
  assert.equal(ctx.notes.length, 0, 'locked: silent, and no errors');
  sfx.unlock();
  music.sync();
  run(1);
  assert.ok(ctx.notes.length > 0, 'unlocked: it plays');
  assert.equal(music.theme, 'lake');
});

test('a theme schedules chord, bass and melody notes ahead of time, in its own key, and keeps going', () => {
  const { ctx, sfx, music, run } = rig();
  sfx.unlock();
  music.setTheme('lake');
  run(6);
  const t = DATA.themes.lake;
  const midi = (m) => 440 * 2 ** ((m - 69) / 12);
  const allowed = new Set();
  for (const chord of t.chords) for (const s of chord) allowed.add(Math.round(midi(t.root + s)));
  const first = ctx.notes[0];
  assert.ok(allowed.has(Math.round(first.freq)), 'the first note is a chord tone of the key');
  assert.ok(ctx.notes.length > 20, `a few seconds of music: ${ctx.notes.length} notes`);
  assert.ok(ctx.notes.every((n) => n.at >= 0.09), 'never scheduled in the past');
  const before = ctx.notes.length;
  run(6);
  assert.ok(ctx.notes.length > before + 10, 'it keeps scheduling');
  assert.ok(Math.max(...ctx.notes.map((n) => n.at)) <= ctx.currentTime + 0.6, 'but only a little way ahead');
  const types = new Set(ctx.notes.map((n) => n.type));
  assert.ok(types.has(t.voices.pad) && types.has(t.voices.melody));
});

test('the same bar always plays the same tune (no randomness between runs), and different themes sound different', () => {
  const a = rig();
  a.sfx.unlock();
  a.music.setTheme('lake');
  a.run(8);
  const b = rig();
  b.sfx.unlock();
  b.music.setTheme('lake');
  b.run(8);
  assert.deepEqual(a.ctx.notes.map((n) => Math.round(n.freq)), b.ctx.notes.map((n) => Math.round(n.freq)));

  const boss = rig();
  boss.sfx.unlock();
  boss.music.setTheme('boss');
  boss.run(8);
  const night = rig();
  night.sfx.unlock();
  night.music.setTheme('night');
  night.run(8);
  assert.notDeepEqual([...freqs(boss.ctx)].sort(), [...freqs(a.ctx)].sort());
  assert.ok(boss.ctx.notes.length > a.ctx.notes.length * 1.3, 'the boss theme is busier');
  assert.ok(night.ctx.notes.length < a.ctx.notes.length, 'the night theme is sparser');
});

test('changing theme fades the old one out, then starts the new one; asking for the same one again changes nothing', () => {
  const { ctx, sfx, music, run } = rig();
  sfx.unlock();
  music.setTheme('lake');
  run(3);
  const count = ctx.notes.length;
  music.setTheme('lake');
  music.sync();
  run(0.3);
  assert.ok(ctx.notes.length > count, 'still just playing the lake tune');
  const out = music.out.gain;
  music.setTheme('boss');
  assert.equal(music.theme, null, 'the lake tune stopped scheduling');
  const marker = ctx.notes.length;
  run(0.3);
  assert.equal(ctx.notes.length, marker, 'a moment of silence while it fades');
  run(2);
  assert.equal(music.theme, 'boss');
  assert.ok(ctx.notes.length > marker, 'and then the boss theme plays');
  assert.ok(out, 'one output gain, reused');
  assert.equal(music.out.gain, out);
});

test('stop() and a null theme silence it; unknown themes are ignored; muting works through the Sfx master volume', () => {
  const { ctx, sfx, music, run } = rig();
  sfx.unlock();
  music.setTheme('night');
  run(2);
  assert.ok(ctx.notes.length > 0);
  music.setTheme('nope');
  assert.equal(music.wanted, 'night', 'an unknown theme changes nothing');
  music.setTheme(null);
  run(1);
  const silent = ctx.notes.length;
  run(3);
  assert.equal(ctx.notes.length, silent, 'null = silence');
  music.setTheme('lake');
  run(2);
  assert.ok(ctx.notes.length > silent, 'it can start again');
  music.stop();
  const stopped = ctx.notes.length;
  run(3);
  assert.equal(ctx.notes.length, stopped);
  assert.equal(music.theme, null);
  // the music is routed through the same master as the effects, so M (mute) silences it too
  sfx.setMuted(true);
  assert.equal(sfx.master.gain.value, 0);
});

test('without WebAudio at all everything is a quiet no-op', () => {
  const sfx = new Sfx({ createContext: () => null, storage: storage() });
  const music = new Music(sfx, { config: DATA, setTimer: () => { throw new Error('no timers needed'); } });
  assert.doesNotThrow(() => {
    sfx.unlock();
    music.setTheme('lake');
    music.sync();
    music.stop();
  });
});
