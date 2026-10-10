const W = 480; // internal canvas
const H = 270;
const TIME_LABEL = { dawn: 'Dawn', day: 'Day', dusk: 'Dusk', night: 'Night' };
const WEATHER_LABEL = { clear: 'Clear', rain: 'Rain', fog: 'Fog', storm: 'Storm' };
const WARM = 0xff8a50;
const COOL = 0x0b1840;
const EASE_PER_SEC = 0.5; // how fast weather fades in and out (a change takes about 2 s)

const mix = (a, b, t) => {
  const ch = (shift) => Math.round(((a >> shift) & 255) * (1 - t) + ((b >> shift) & 255) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
};

/**
 * Everything the sky does on screen: the day/night tint, rain, fog, lightning, and the small "Day - Rain" chip and
 * event banner. It draws whatever World.state() says for the current shared clock; it never decides anything.
 * All of it is screen-space and sits above the world but below the interface.
 */
export default class WorldFx {
  /**
   * @param {Phaser.Scene} scene
   * @param {{mapName: string, mapId: string, state: () => object | null, sfx?: object, eventInfo: (id: string) => {name: string, text: string}}} opts
   *   `state()` returns World.state(...) or null when the world is switched off (then nothing is drawn).
   */
  constructor(scene, { mapName, mapId, state, sfx = null, eventInfo }) {
    this.scene = scene;
    this.mapName = mapName;
    this.mapId = mapId;
    this.getState = state;
    this.sfx = sfx;
    this.eventInfo = eventInfo;
    this.current = null;
    this.rainLevel = 0; // 0..1 eased
    this.fogLevel = 0;
    this.darkness = 0;
    this.warmth = 0;
    this.time = 0;
    this.sinceState = 99;
    this.nextLightning = 8;
    this.shownEvents = new Set();
    this.drops = Array.from({ length: 160 }, () => ({ x: Math.random() * W, y: Math.random() * H, v: 0.7 + Math.random() * 0.6 }));

    const layer = (depth) => scene.add.rectangle(0, 0, W, H, 0x000000, 0).setOrigin(0).setScrollFactor(0).setDepth(depth);
    this.tint = layer(6000);
    this.fog = layer(6001).setFillStyle(0xcfd8e0, 0);
    this.rain = scene.add.graphics().setScrollFactor(0).setDepth(6002);
    this.flash = layer(6003).setFillStyle(0xffffff, 0);

    const text = (size, color) => scene.add.text(0, 0, '', { fontFamily: 'monospace', fontSize: size, color, stroke: '#000000', strokeThickness: 2 })
      .setResolution(4).setScrollFactor(0).setDepth(9991);
    this.chip = text('7px', '#cfe6ff').setOrigin(1, 0).setPosition(472, 38);
    this.eventLine = text('7px', '#ffd166').setOrigin(1, 0).setPosition(472, 54);
    this.announce = text('9px', '#ffd166').setOrigin(0.5, 0).setPosition(W / 2, 100).setAlpha(0).setDepth(9995);
    this.announce.setBackgroundColor('#000000dd').setPadding(6, 3, 6, 3).setAlign('center').setWordWrapWidth(420);
  }

  update(dt) {
    this.time += dt;
    this.sinceState += dt;
    if (this.sinceState > 0.5) {
      this.sinceState = 0;
      this.refreshState();
    }
    const s = this.current;
    if (!s) return;

    // Ease toward the targets so weather arrives and leaves gradually.
    const ease = (v, target) => v + Math.sign(target - v) * Math.min(Math.abs(target - v), EASE_PER_SEC * dt);
    this.rainLevel = ease(this.rainLevel, { rain: 0.5, storm: 1 }[s.weather] ?? 0);
    this.fogLevel = ease(this.fogLevel, { fog: 1, storm: 0.3, rain: 0.2 }[s.weather] ?? 0);
    const darkness = (1 - s.daylight) / 0.88;
    this.darkness = ease(this.darkness, darkness);
    this.warmth = ease(this.warmth, s.time === 'dawn' || s.time === 'dusk' ? 1 - darkness : 0);

    // Day/night tint: cool and dark at night, warm orange around dawn and dusk.
    this.tint.setFillStyle(mix(COOL, WARM, this.warmth), this.darkness * 0.5 + this.warmth * 0.06);
    this.fog.setFillStyle(0xcfd8e0, this.fogLevel * 0.28 + this.rainLevel * 0.08 + (s.time === 'night' ? 0 : 0));

    this.drawRain(dt, s.weather === 'storm');
    this.lightning(dt, s.weather === 'storm');
    this.flash.setAlpha(Math.max(0, this.flash.alpha - dt * 3));
  }

  refreshState() {
    const prev = this.current;
    this.current = this.getState();
    const s = this.current;
    if (!s) {
      this.chip.setText('');
      this.eventLine.setText('');
      return;
    }
    this.chip.setText(`${this.mapName}  ${TIME_LABEL[s.time]}  ${WEATHER_LABEL[s.weather]}`);
    this.eventLine.setText(s.events.map((id) => `* ${this.eventInfo(id)?.name ?? id}`).join('  '));
    if (prev?.weather !== s.weather) this.sfx?.setWeather(s.weather);
    // Tell the player when an event starts (once per start, also when they arrive in the middle of one).
    for (const id of s.events) {
      if (this.shownEvents.has(id)) continue;
      this.shownEvents.add(id);
      const info = this.eventInfo(id);
      if (info) this.showAnnouncement(`${info.name}: ${info.text}`);
    }
    for (const id of [...this.shownEvents]) if (!s.events.includes(id)) this.shownEvents.delete(id);
  }

  showAnnouncement(text) {
    this.announce.setText(text).setAlpha(1);
    this.scene.tweens.killTweensOf(this.announce);
    this.scene.tweens.add({ targets: this.announce, alpha: 0, delay: 4500, duration: 600 });
    this.sfx?.play('record');
  }

  drawRain(dt, storm) {
    const g = this.rain.clear();
    const count = Math.round(this.rainLevel * (storm ? 160 : 80));
    if (count === 0) return;
    g.lineStyle(1, storm ? 0xb8c8e8 : 0xcfe0f5, 0.55);
    const slant = storm ? 0.45 : 0.18; // wind
    for (let i = 0; i < count; i++) {
      const d = this.drops[i];
      d.y += 260 * d.v * dt;
      d.x -= 260 * d.v * dt * slant;
      if (d.y > H) {
        d.y = -6;
        d.x = Math.random() * (W + 80);
      }
      if (d.x < -10) d.x += W + 20;
      const len = storm ? 7 : 5;
      g.lineBetween(Math.round(d.x), Math.round(d.y), Math.round(d.x - len * slant), Math.round(d.y + len));
    }
  }

  lightning(dt, storm) {
    if (!storm) {
      this.nextLightning = 6 + Math.random() * 6;
      return;
    }
    this.nextLightning -= dt;
    if (this.nextLightning > 0) return;
    this.nextLightning = 7 + Math.random() * 9;
    this.flash.setAlpha(0.55);
    this.scene.time.delayedCall(250 + Math.random() * 500, () => this.sfx?.play('thunder')); // sound trails the flash
  }

  destroy() {
    this.sfx?.setWeather('clear');
    for (const o of [this.tint, this.fog, this.rain, this.flash, this.chip, this.eventLine, this.announce]) o.destroy();
  }
}
