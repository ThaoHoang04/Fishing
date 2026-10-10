import { TEXTURES } from '../constants/assetKeys.js';
import { REEL } from '../systems/ReelSim.js';

// Screen-space layout (internal 480x270 canvas).
const X = 140;
const W = 200;
const Y = 196;

/**
 * Reeling HUD for the camera-followed player: distance (the fish icon slides toward you as you reel),
 * tension (green / yellow / red with a shake near the limit) and a clear warning for the fish's pulls.
 */
export default class ReelHud {
  constructor(scene) {
    this.g = scene.add.graphics().setScrollFactor(0).setDepth(10002);
    const text = (size, color) =>
      scene.add.text(0, 0, '', { fontFamily: 'monospace', fontSize: size, color, stroke: '#000000', strokeThickness: 2 })
        .setResolution(4).setScrollFactor(0).setDepth(10003).setVisible(false);
    this.title = text('8px', '#ffffff').setOrigin(0.5, 1);
    this.warn = text('10px', '#ffe14d').setOrigin(0.5, 1);
    this.icon = scene.add.image(0, 0, TEXTURES.FISH_ICONS, 0).setScrollFactor(0).setDepth(10003).setVisible(false);
    this.role = text('8px', '#9fe3ff').setOrigin(0.5, 0);
    this.labelL = text('6px', '#9fc4ff').setOrigin(0, 1);
    this.labelR = text('6px', '#9fc4ff').setOrigin(1, 1);
    this.time = 0;
  }

  /** @param {import('../systems/ReelSim.js').ReelSim} sim  @param {{name: string, icon: number}} species @param {string} archetype */
  draw(sim, species, archetype, dt, { weight = null, overweight = false, role = null, roleLine = '' } = {}) {
    this.time += dt;
    const g = this.g.clear();
    const progress = 1 - sim.distance / REEL.MAX_DISTANCE;
    const t = sim.tension / REEL.MAX_TENSION;
    const shake = sim.tension >= REEL.DANGER_TENSION ? Math.round(Math.sin(this.time * 60) * 1.2) : 0;

    // panel
    g.fillStyle(0x000000, 0.55).fillRect(X - 10, Y - 16, W + 20, 62);

    // distance track + fish marker
    g.fillStyle(0x1d3557, 1).fillRect(X, Y + 2, W, 5);
    g.fillStyle(0x4aa8ff, 1).fillRect(X, Y + 2, Math.round(W * Math.max(0, progress)), 5);
    this.icon.setVisible(true).setFrame(species.icon).setPosition(Math.round(X + W * (1 - Math.max(0, Math.min(1, progress))) ), Y - 4 + Math.round(Math.sin(this.time * 8)));
    this.icon.setFlipX(true);

    // tension bar: coloured zones, filled up to the current value
    const ty = Y + 16;
    const zone = (from, to, color) => g.fillStyle(color, 1).fillRect(X + Math.round(W * from) + shake, ty, Math.round(W * (to - from)), 8);
    const warn = REEL.WARN_TENSION / REEL.MAX_TENSION;
    const danger = REEL.DANGER_TENSION / REEL.MAX_TENSION;
    g.fillStyle(0x000000, 1).fillRect(X - 1 + shake, ty - 1, W + 2, 10);
    // dim background zones
    for (const [a, b, c] of [[0, warn, 0x1f4d2b], [warn, danger, 0x5a4a14], [danger, 1, 0x5a1f1f]]) zone(a, b, c);
    // bright fill
    const fill = (from, to, color) => {
      const hi = Math.min(t, to);
      if (hi > from) g.fillStyle(color, 1).fillRect(X + Math.round(W * from) + shake, ty, Math.round(W * (hi - from)), 8);
    };
    fill(0, warn, 0x4ade80);
    fill(warn, danger, 0xfacc15);
    fill(danger, 1, 0xff4d4d);

    this.labelL.setVisible(true).setPosition(X, Y + 1).setText('YOU');
    this.labelR.setVisible(true).setPosition(X + W, Y + 1).setText('FISH');

    const kg = weight ? ` ${weight.toFixed(1)}kg` : '';
    this.title.setVisible(true).setPosition(240, Y - 6).setText(`${species.name}${kg} - ${archetype}`).setColor(overweight ? '#ff8a8a' : '#ffffff');
    if (roleLine) this.role.setVisible(true).setPosition(240, Y + 50).setText(roleLine);
    else this.role.setVisible(false);
    // Pull warning: the one thing a player must react to.
    const blink = Math.floor(this.time * 12) % 2 === 0;
    if (role === 'ease' && (sim.phase === 'telegraph' || sim.phase === 'pull')) this.warn.setVisible(true).setColor('#7fd1ff').setText(blink ? 'EASE THE LINE!' : '').setPosition(240, Y + 44);
    else if (sim.enraged && sim.phase === 'rest') this.warn.setVisible(true).setColor('#ff6b6b').setText('ENRAGED!').setPosition(240, Y + 44);
    else if (sim.phase === 'telegraph') this.warn.setVisible(true).setColor('#ffe14d').setText(blink ? 'LET GO!' : '').setPosition(240, Y + 44);
    else if (sim.phase === 'pull') this.warn.setVisible(true).setColor('#ff6b6b').setText('PULLING!').setPosition(240, Y + 44);
    else if (overweight) this.warn.setVisible(true).setColor('#ff8a8a').setText('HEAVY! line too weak').setPosition(240, Y + 44);
    else this.warn.setVisible(false);
  }

  hide() {
    this.g.clear();
    for (const o of [this.title, this.warn, this.icon, this.labelL, this.labelR, this.role]) o.setVisible(false);
  }

  destroy() {
    for (const o of [this.g, this.title, this.warn, this.icon, this.labelL, this.labelR, this.role]) o.destroy();
  }
}
