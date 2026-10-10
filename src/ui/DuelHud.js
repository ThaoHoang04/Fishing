import { needleAt } from '../systems/Steal.js';

const W = 220;
const H = 14;
const X = 240 - W / 2;
const Y = 118;

/**
 * The timing bar of a fish duel: a needle sweeps along the bar, press SPACE to stop it as close to the middle as you can.
 * Drawing only: the server judges the presses.
 */
export default class DuelHud {
  constructor(scene) {
    this.scene = scene;
    this.g = scene.add.graphics().setScrollFactor(0).setDepth(10010).setVisible(false);
    const label = (size, color) => scene.add
      .text(240, Y, '', { fontFamily: 'sans-serif', fontSize: size, color, stroke: '#000000', strokeThickness: 3, align: 'center' })
      .setOrigin(0.5, 1).setResolution(4).setScrollFactor(0).setDepth(10011).setVisible(false);
    this.title = label('11px', '#ffe14d');
    this.sub = label('8px', '#ffffff');
    this.sub.setY(Y + H + 16).setOrigin(0.5, 0);
    this.active = null;
  }

  get isActive() {
    return this.active !== null;
  }

  /** @param {{startIn: number, durationMs: number, period: number, zone: number, title: string}} d */
  begin(d) {
    this.active = { ...d, startAt: this.scene.time.now + d.startIn, pressedAt: null };
    this.g.setVisible(true);
    this.title.setVisible(true).setText(d.title);
    this.sub.setVisible(true);
  }

  /** Our press: the needle freezes where it was. Returns false if it was too early, late, or already done. */
  press() {
    const a = this.active;
    if (!a || a.pressedAt !== null) return false;
    const t = this.scene.time.now - a.startAt;
    if (t < 0 || t > a.durationMs) return false;
    a.pressedAt = t;
    return true;
  }

  end() {
    this.active = null;
    this.g.setVisible(false).clear();
    this.title.setVisible(false);
    this.sub.setVisible(false);
  }

  update() {
    const a = this.active;
    if (!a) return;
    const t = this.scene.time.now - a.startAt;
    const g = this.g.clear();
    g.fillStyle(0x000000, 0.75).fillRect(X - 4, Y - 4 + 0, W + 8, H + 8);
    g.fillStyle(0x3a4a66, 1).fillRect(X, Y, W, H);
    const zoneW = W * a.zone * 2;
    g.fillStyle(0x7be08a, 1).fillRect(X + W / 2 - zoneW / 2, Y, zoneW, H); // the perfect band
    g.lineStyle(1, 0xffffff, 0.8).strokeRect(X, Y, W, H);
    if (t < 0) {
      this.sub.setText(`Get ready... ${Math.ceil(-t / 300)}`);
      return;
    }
    const at = a.pressedAt ?? Math.min(t, a.durationMs);
    const n = needleAt(at, a.period);
    const nx = X + n * W;
    g.fillStyle(a.pressedAt === null ? 0xffe14d : 0xff7b3a, 1).fillRect(Math.round(nx) - 1, Y - 5, 3, H + 10);
    this.sub.setText(a.pressedAt === null ? 'SPACE: stop the needle in the middle!' : 'Locked in! Waiting for the other player...');
  }

  destroy() {
    this.g.destroy();
    this.title.destroy();
    this.sub.destroy();
  }
}
