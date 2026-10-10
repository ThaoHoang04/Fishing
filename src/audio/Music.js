import { mulberry32 } from '../systems/ReelSim.js';

const LOOKAHEAD_S = 0.45; // schedule notes this far ahead
const TICK_MS = 120;
const FADE_IN_S = 1.5;
const FADE_OUT_S = 0.7;
const STEPS_PER_BAR = 8; // eighth notes
const SOFTEN_HZ = 2600;

const midi = (m) => 440 * 2 ** ((m - 69) / 12);

/**
 * Background music, synthesised like the sound effects (nothing to license): a slow chord pad, a bass line and a melody that
 * picks one of a few patterns per bar, all from src/data/music.json. Themes: the cozy lake, night fishing, the boss fight.
 * Switching theme fades out and in. It shares the Sfx audio context and master volume, so M mutes it too.
 */
export default class Music {
  /**
   * @param {import('./Sfx.js').default} sfx
   * @param {{config: {themes: object, volume: number}, setTimer?: Function, clearTimer?: Function}} opts  `config` is src/data/music.json (the
   *   caller imports it: the browser bundler and Node load JSON differently); the timers are injectable for tests
   */
  constructor(sfx, { config, setTimer = (fn, ms) => setInterval(fn, ms), clearTimer = (id) => clearInterval(id) }) {
    this.sfx = sfx;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.themes = config.themes;
    this.volume = config.volume;
    this.out = null; // this module's gain, under the Sfx master
    this.theme = null; // id of the theme that is playing
    this.wanted = null; // id of the theme we should be playing (set before the audio is unlocked, too)
    this.timer = null;
    this.step = 0;
    this.nextTime = 0;
    this.silentUntil = 0; // a new theme waits until the old one has faded out
    this.retry = null;
  }

  /** Ask for a theme (or null for silence). Safe before the first user gesture: it starts when the audio unlocks. */
  setTheme(id) {
    if (id !== null && !this.themes[id]) return;
    this.wanted = id;
    this.sync();
  }

  /** Call whenever the audio may have become available (the scene calls it every so often). */
  sync() {
    const ctx = this.sfx.ctx;
    if (!ctx || !this.sfx.master || this.wanted === this.theme) return;
    if (!this.out) {
      this.out = ctx.createGain();
      this.out.gain.value = 0;
      // Softens the sharp edges of the square and sawtooth voices (the boss theme) so the music stays in the background.
      const soften = ctx.createBiquadFilter();
      soften.type = 'lowpass';
      soften.frequency.value = SOFTEN_HZ;
      this.out.connect(soften);
      soften.connect(this.sfx.master);
    }
    if (this.theme !== null) {
      // a different theme (or silence) was asked for: fade the old one out first
      this.stopTimer();
      this.fade(0, FADE_OUT_S);
      this.theme = null;
      this.silentUntil = ctx.currentTime + FADE_OUT_S;
    }
    if (this.wanted === null) return;
    if (ctx.currentTime < this.silentUntil) {
      // still fading: try again a moment later
      this.retry ??= this.setTimer(() => {
        this.clearTimer(this.retry);
        this.retry = null;
        this.sync();
      }, 400);
      return;
    }
    this.begin(this.wanted);
  }

  begin(id) {
    const ctx = this.sfx.ctx;
    this.theme = id;
    this.step = 0;
    this.nextTime = ctx.currentTime + 0.1;
    this.fade(this.volume, FADE_IN_S);
    this.stopTimer();
    this.timer = this.setTimer(() => this.pump(), TICK_MS);
    this.pump();
  }

  fade(level, seconds) {
    const g = this.out?.gain;
    const ctx = this.sfx.ctx;
    if (!g || !ctx) return;
    g.setValueAtTime?.(g.value, ctx.currentTime);
    g.linearRampToValueAtTime?.(level, ctx.currentTime + seconds);
    if (!g.setValueAtTime) g.value = level;
  }

  stopTimer() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }

  stop() {
    this.wanted = null;
    this.stopTimer();
    if (this.retry) this.clearTimer(this.retry);
    this.retry = null;
    this.fade(0, 0.3);
    this.theme = null;
  }

  /** Schedule every note that falls inside the lookahead window. */
  pump() {
    const ctx = this.sfx.ctx;
    const theme = this.themes[this.theme];
    if (!ctx || !theme || ctx.state === 'closed') return;
    const stepS = 60 / theme.bpm / 2;
    while (this.nextTime < ctx.currentTime + LOOKAHEAD_S) {
      this.playStep(theme, this.step, this.nextTime, stepS);
      this.step++;
      this.nextTime += stepS;
    }
  }

  playStep(theme, step, t, stepS) {
    const bar = Math.floor(step / STEPS_PER_BAR);
    const inBar = step % STEPS_PER_BAR;
    const chordIndex = bar % theme.chords.length;
    const chord = theme.chords[chordIndex];
    if (inBar === 0) {
      for (const semi of chord) this.note(midi(theme.root + semi), t, stepS * STEPS_PER_BAR * 0.97, theme.voices.pad, theme.levels.pad);
    }
    if (theme.bassPattern[inBar]) this.note(midi(theme.root + theme.bass[chordIndex] - 12), t, stepS * 1.7, theme.voices.bass, theme.levels.bass);
    const rng = mulberry32(bar * 7919 + theme.bpm);
    const melody = theme.melodies[Math.floor(rng() * theme.melodies.length)];
    const degree = melody[inBar];
    if (degree !== null && degree !== undefined) {
      const n = theme.scale.length;
      const semi = theme.scale[((degree % n) + n) % n] + 12 * Math.floor(degree / n);
      this.note(midi(theme.root + 12 + semi), t, stepS * 1.6, theme.voices.melody, theme.levels.melody);
    }
  }

  note(freq, t, dur, type, vol) {
    const ctx = this.sfx.ctx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(vol, t + Math.min(0.08, dur * 0.3));
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain);
    gain.connect(this.out);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }
}
