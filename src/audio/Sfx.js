// Sound effects and ambience, synthesised with WebAudio at run time: no audio files, so nothing to license.
//
// Browsers only allow sound after a user gesture; `unlock()` is called on the first key / click. Everything is
// a no-op until then (and when there is no WebAudio at all), so callers never have to check.

const MAX_VOICES = 24; // sounds playing at once; extra ones are dropped instead of turning into mush
const MUTE_KEY = 'ft_muted';
const RARITY_NOTES = {
  common: [523, 659],
  rare: [523, 659, 784],
  epic: [523, 659, 784, 1047],
  legendary: [523, 659, 784, 1047, 1319, 1568],
};

export default class Sfx {
  /**
   * @param {{createContext?: () => AudioContext | null, storage?: Storage | null}} opts both injectable for tests
   */
  constructor({ createContext = defaultContext, storage = safeStorage() } = {}) {
    this.createContext = createContext;
    this.storage = storage;
    this.ctx = null;
    this.master = null;
    this.noise = null;
    this.voices = [];
    this.ambient = null;
    this.wantAmbient = false;
    this.muted = this.readMuted();
  }

  /** Call from a user gesture (key / click). Safe to call repeatedly. */
  unlock() {
    if (!this.ctx) {
      try {
        this.ctx = this.createContext();
      } catch {
        this.ctx = null;
      }
      if (!this.ctx) return;
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.6;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume?.();
    if (this.wantAmbient) this.startAmbient();
    if (this.weather) this.setWeather(this.weather);
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.6;
    try {
      this.storage?.setItem(MUTE_KEY, this.muted ? '1' : '0');
    } catch { /* private mode */ }
  }

  toggleMute() {
    this.setMuted(!this.muted);
    if (!this.muted) this.play('click');
    return this.muted;
  }

  /** Play a named effect. `arg` is the rarity for 'catch'. Unknown names are ignored. */
  play(name, arg) {
    const sound = SOUNDS[name];
    if (!sound || !this.ctx || this.muted || this.ctx.state === 'closed') return;
    this.voices = this.voices.filter((end) => end > this.ctx.currentTime);
    if (this.voices.length >= MAX_VOICES) return;
    sound(this, arg);
  }

  startAmbient() {
    this.wantAmbient = true;
    if (!this.ctx || this.ambient) return;
    // Lake ambience: low-passed noise whose volume slowly breathes.
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer();
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 420;
    const gain = this.ctx.createGain();
    gain.gain.value = 0.05;
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.18;
    const depth = this.ctx.createGain();
    depth.gain.value = 0.025;
    lfo.connect(depth);
    depth.connect(gain.gain);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    src.start();
    lfo.start();
    this.ambient = { src, lfo };
  }

  /** Rain / storm bed under everything else; `kind` is 'clear' | 'fog' | 'rain' | 'storm'. Fades in and out. */
  setWeather(kind) {
    this.weather = kind;
    if (!this.ctx || !this.master) return;
    if (!this.rain) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuffer();
      src.loop = true;
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'highpass';
      filter.frequency.value = 1400;
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      src.connect(filter);
      filter.connect(gain);
      gain.connect(this.master);
      src.start();
      this.rain = { src, gain };
    }
    const level = { rain: 0.05, storm: 0.1 }[kind] ?? 0;
    const now = this.ctx.currentTime;
    this.rain.gain.gain.setValueAtTime(this.rain.gain.gain.value, now);
    this.rain.gain.gain.linearRampToValueAtTime(level, now + 2);
  }

  stopAmbient() {
    this.wantAmbient = false;
    if (!this.ambient) return;
    for (const node of [this.ambient.src, this.ambient.lfo]) {
      try {
        node.stop();
      } catch { /* already stopped */ }
    }
    this.ambient = null;
  }

  // --- building blocks used by the sound table ---

  /** A pitched blip. `to` slides the pitch over the note; `delay` is seconds from now. */
  tone(freq, { type = 'square', dur = 0.1, vol = 0.15, delay = 0, to = freq } = {}) {
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (to !== freq) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + dur);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(vol, t + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
    this.voices.push(t + dur + 0.02);
  }

  /** A burst of filtered noise (whooshes, splashes, snaps). */
  burst({ dur = 0.2, vol = 0.12, delay = 0, filter = 'lowpass', from = 1200, to = from } = {}) {
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer();
    const f = this.ctx.createBiquadFilter();
    f.type = filter;
    f.frequency.setValueAtTime(from, t);
    if (to !== from) f.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + dur);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(vol, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f);
    f.connect(gain);
    gain.connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.02);
    this.voices.push(t + dur + 0.02);
  }

  noiseBuffer() {
    if (!this.noise) {
      const rate = this.ctx.sampleRate || 44100;
      const buffer = this.ctx.createBuffer(1, rate, rate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      this.noise = buffer;
    }
    return this.noise;
  }

  readMuted() {
    try {
      return this.storage?.getItem(MUTE_KEY) === '1';
    } catch {
      return false;
    }
  }
}

const arpeggio = (s, notes, { gap = 0.075, type = 'square', vol = 0.12, dur = 0.16 } = {}) =>
  notes.forEach((f, i) => s.tone(f, { type, vol, dur, delay: i * gap }));

/** name -> (sfx, arg) => void */
export const SOUNDS = {
  click: (s) => s.tone(720, { dur: 0.04, vol: 0.08 }),
  cast: (s) => s.burst({ dur: 0.28, vol: 0.14, filter: 'bandpass', from: 400, to: 2200 }),
  splash: (s) => {
    s.burst({ dur: 0.3, vol: 0.16, filter: 'lowpass', from: 1800, to: 300 });
    s.tone(220, { type: 'sine', dur: 0.15, vol: 0.12, to: 80 });
  },
  bite: (s) => {
    s.tone(880, { dur: 0.08, vol: 0.16 });
    s.tone(1320, { dur: 0.1, vol: 0.16, delay: 0.1 });
  },
  hook: (s) => {
    s.tone(520, { type: 'triangle', dur: 0.14, vol: 0.18, to: 900 });
    s.burst({ dur: 0.06, vol: 0.1, filter: 'highpass', from: 2500 });
  },
  reel: (s) => s.tone(170, { dur: 0.035, vol: 0.05 }),
  pull: (s) => s.tone(130, { type: 'sawtooth', dur: 0.28, vol: 0.1, to: 80 }),
  warn: (s) => s.tone(1000, { dur: 0.07, vol: 0.12 }),
  snap: (s) => {
    s.burst({ dur: 0.16, vol: 0.2, filter: 'highpass', from: 1800 });
    s.tone(320, { type: 'sawtooth', dur: 0.22, vol: 0.12, to: 60 });
  },
  fail: (s) => s.tone(320, { type: 'triangle', dur: 0.32, vol: 0.14, to: 140 }),
  catch: (s, rarity = 'common') => arpeggio(s, RARITY_NOTES[rarity] ?? RARITY_NOTES.common, { dur: 0.2 }),
  discover: (s) => {
    arpeggio(s, [784, 988, 1175, 1568], { gap: 0.07, type: 'triangle', vol: 0.14, dur: 0.22 });
    s.tone(1568, { type: 'sine', dur: 0.5, vol: 0.1, delay: 0.3 });
  },
  record: (s) => arpeggio(s, [659, 880, 1319], { gap: 0.08, type: 'triangle', vol: 0.14, dur: 0.2 }),
  rare: (s) => {
    s.tone(1047, { type: 'sine', dur: 0.5, vol: 0.14 });
    s.tone(1568, { type: 'sine', dur: 0.6, vol: 0.1, delay: 0.08 });
  },
  sell: (s) => {
    s.tone(988, { dur: 0.07, vol: 0.14 });
    s.tone(1319, { dur: 0.16, vol: 0.14, delay: 0.07 });
  },
  buy: (s) => arpeggio(s, [660, 880, 1100], { gap: 0.06, type: 'triangle', vol: 0.14 }),
  equip: (s) => s.tone(440, { type: 'triangle', dur: 0.12, vol: 0.14, to: 660 }),
  steal: (s) => {
    s.tone(880, { type: 'square', dur: 0.06, vol: 0.12 });
    s.tone(660, { type: 'square', dur: 0.06, vol: 0.12, delay: 0.07 });
    s.tone(990, { type: 'square', dur: 0.1, vol: 0.12, delay: 0.14 });
  },
  gull: (s) => {
    s.tone(1500, { type: 'triangle', dur: 0.12, vol: 0.1, to: 900 });
    s.tone(1400, { type: 'triangle', dur: 0.12, vol: 0.1, to: 800, delay: 0.16 });
  },
  rescue: (s) => arpeggio(s, [523, 659, 784, 1047], { gap: 0.07, type: 'triangle', vol: 0.14, dur: 0.18 }),
  bump: (s) => {
    s.burst({ dur: 0.14, vol: 0.14, filter: 'lowpass', from: 500, to: 120 });
    s.tone(90, { type: 'sine', dur: 0.14, vol: 0.14, to: 55 });
  },
  big: (s) => {
    s.burst({ dur: 0.3, vol: 0.22, filter: 'lowpass', from: 900, to: 90 });
    s.tone(80, { type: 'sine', dur: 0.35, vol: 0.22, to: 40 });
    s.tone(240, { type: 'square', dur: 0.1, vol: 0.12, to: 120, delay: 0.02 });
  },
  throw: (s) => s.burst({ dur: 0.1, vol: 0.12, filter: 'bandpass', from: 700, to: 2200 }),
  duel: (s) => {
    s.tone(880, { type: 'triangle', dur: 0.5, vol: 0.14 });
    s.tone(1320, { type: 'sine', dur: 0.6, vol: 0.08, delay: 0.02 });
  },
  swish: (s) => s.burst({ dur: 0.12, vol: 0.1, filter: 'highpass', from: 1200, to: 3000 }),
  slap: (s) => {
    s.burst({ dur: 0.09, vol: 0.2, filter: 'highpass', from: 2500, to: 1500 });
    s.tone(240, { type: 'square', dur: 0.08, vol: 0.12, to: 120 });
  },
  push: (s) => {
    s.burst({ dur: 0.18, vol: 0.18, filter: 'lowpass', from: 700, to: 150 });
    s.tone(110, { type: 'sine', dur: 0.2, vol: 0.18, to: 60 });
  },
  bonk: (s) => {
    s.tone(520, { type: 'triangle', dur: 0.1, vol: 0.2, to: 180 });
    s.tone(330, { type: 'sine', dur: 0.18, vol: 0.14, to: 140, delay: 0.06 });
  },
  emote: (s) => s.tone(620, { type: 'sine', dur: 0.1, vol: 0.14, to: 920 }),
  error: (s) => s.tone(200, { dur: 0.14, vol: 0.12 }),
  horn: (s) => {
    s.tone(196, { type: 'sawtooth', dur: 0.5, vol: 0.12 });
    s.tone(247, { type: 'sawtooth', dur: 0.5, vol: 0.09 });
  },
  thunder: (s) => {
    s.burst({ dur: 1.1, vol: 0.22, filter: 'lowpass', from: 500, to: 60 });
    s.tone(60, { type: 'sine', dur: 0.9, vol: 0.18, to: 30, delay: 0.05 });
  },
  boss: (s) => {
    arpeggio(s, [262, 330, 392, 523, 659, 784, 1047], { gap: 0.09, type: 'triangle', vol: 0.15, dur: 0.3 });
    s.tone(1047, { type: 'sine', dur: 0.9, vol: 0.12, delay: 0.7 });
  },
};

function defaultContext() {
  const Ctx = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  return Ctx ? new Ctx() : null;
}

function safeStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
