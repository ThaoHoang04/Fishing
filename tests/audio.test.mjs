import { test } from 'node:test';
import assert from 'node:assert/strict';
import Sfx, { SOUNDS } from '../src/audio/Sfx.js';

// A recording stand-in for AudioContext: enough surface for the synth, and it counts what gets scheduled.
function fakeContext() {
  const created = { osc: 0, noise: 0, gain: 0, filter: 0 };
  const started = [];
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} });
  const node = (extra = {}) => ({ connect() { return this; }, ...extra });
  const ctx = {
    state: 'suspended',
    currentTime: 0,
    sampleRate: 8000,
    destination: {},
    created,
    started,
    resumed: 0,
    resume() { this.resumed++; this.state = 'running'; },
    createGain() { created.gain++; return node({ gain: param() }); },
    createOscillator() {
      created.osc++;
      return node({ frequency: param(), type: 'sine', start(t) { started.push(['osc', t]); }, stop() {} });
    },
    createBiquadFilter() { created.filter++; return node({ frequency: param(), type: 'lowpass' }); },
    createBuffer(_ch, len) { return { getChannelData: () => new Float32Array(len) }; },
    createBufferSource() {
      created.noise++;
      return node({ buffer: null, loop: false, start(t) { started.push(['noise', t]); }, stop() {} });
    },
  };
  return ctx;
}
const memoryStorage = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), m };
};
const make = (opts = {}) => {
  const ctx = fakeContext();
  const sfx = new Sfx({ createContext: () => ctx, storage: memoryStorage(), ...opts });
  return { ctx, sfx };
};

test('nothing plays (and nothing throws) before the first user gesture', () => {
  const { ctx, sfx } = make();
  for (const name of Object.keys(SOUNDS)) assert.doesNotThrow(() => sfx.play(name, 'rare'));
  assert.equal(ctx.started.length, 0);
  sfx.unlock();
  assert.equal(ctx.state, 'running', 'unlock resumes a suspended context');
  sfx.play('click');
  assert.ok(ctx.started.length > 0);
});

test('every sound in the table plays by scheduling at least one source', () => {
  for (const name of Object.keys(SOUNDS)) {
    const { ctx, sfx } = make();
    sfx.unlock();
    sfx.play(name, 'epic');
    assert.ok(ctx.started.length > 0, `${name} made no sound`);
  }
  assert.ok(Object.keys(SOUNDS).length >= 15);
  for (const need of ['cast', 'splash', 'bite', 'hook', 'catch', 'snap', 'sell', 'buy', 'emote', 'rare', 'discover', 'record']) {
    assert.ok(SOUNDS[need], `missing sound: ${need}`);
  }
});

test('unknown sounds and missing WebAudio are harmless', () => {
  const { ctx, sfx } = make();
  sfx.unlock();
  assert.doesNotThrow(() => sfx.play('does-not-exist'));
  assert.equal(ctx.started.length, 0);

  const none = new Sfx({ createContext: () => null, storage: memoryStorage() });
  assert.doesNotThrow(() => { none.unlock(); none.play('catch', 'rare'); none.startAmbient(); none.stopAmbient(); none.toggleMute(); });
  const broken = new Sfx({ createContext: () => { throw new Error('no audio device'); }, storage: memoryStorage() });
  assert.doesNotThrow(() => { broken.unlock(); broken.play('cast'); });
});

test('mute silences everything, is remembered, and un-muting works', () => {
  const storage = memoryStorage();
  const ctx = fakeContext();
  const sfx = new Sfx({ createContext: () => ctx, storage });
  sfx.unlock();
  assert.equal(sfx.muted, false);
  assert.equal(sfx.toggleMute(), true);
  const before = ctx.started.length;
  for (const name of Object.keys(SOUNDS)) sfx.play(name, 'legendary');
  assert.equal(ctx.started.length, before, 'muted: no sources are even created');
  assert.equal(sfx.master.gain.value, 0);
  assert.equal(storage.getItem('ft_muted'), '1');

  const reloaded = new Sfx({ createContext: () => fakeContext(), storage });
  assert.equal(reloaded.muted, true, 'the choice survives a reload');
  reloaded.unlock();
  assert.equal(reloaded.master.gain.value, 0, 'and applies as soon as the audio starts');

  assert.equal(sfx.toggleMute(), false);
  assert.ok(sfx.master.gain.value > 0);
  assert.ok(ctx.started.length > before, 'the un-mute click is audible');
});

test('rarer catches get longer fanfares', () => {
  const notes = (rarity) => {
    const { ctx, sfx } = make();
    sfx.unlock();
    sfx.play('catch', rarity);
    return ctx.created.osc;
  };
  const counts = ['common', 'rare', 'epic', 'legendary'].map(notes);
  assert.deepEqual([...counts].sort((a, b) => a - b), counts, JSON.stringify(counts));
  assert.ok(counts[3] > counts[0]);
  assert.equal(notes('mystery'), counts[0], 'an unknown rarity falls back to the common jingle');
});

test('a flood of sounds is capped instead of piling up', () => {
  const { ctx, sfx } = make();
  sfx.unlock();
  for (let i = 0; i < 500; i++) sfx.play('splash');
  assert.ok(ctx.started.length <= 24 * 3, `started ${ctx.started.length} voices at the same instant`);
  ctx.currentTime += 5; // a few seconds later the voices are done and sound works again
  const n = ctx.started.length;
  sfx.play('click');
  assert.ok(ctx.started.length > n);
});

test('ambience starts once, stops cleanly, and waits for the first gesture', () => {
  const { ctx, sfx } = make();
  sfx.startAmbient(); // before unlock: remembered
  assert.equal(ctx.created.noise, 0);
  sfx.unlock();
  assert.equal(ctx.created.noise, 1, 'starts as soon as audio is available');
  sfx.startAmbient();
  sfx.startAmbient();
  assert.equal(ctx.created.noise, 1, 'never layered twice');
  sfx.stopAmbient();
  sfx.stopAmbient();
  sfx.startAmbient();
  assert.equal(ctx.created.noise, 2, 'can be restarted');
});
