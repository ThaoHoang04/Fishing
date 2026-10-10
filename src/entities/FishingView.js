import { TEXTURES, animKey } from '../constants/assetKeys.js';

/**
 * Everything drawn out on the water for one fishing line: the bobber (A6 VFX), the line from the
 * rod tip, the landing splash and the "!" over the player's head when a fish bites.
 * Used for the local player and, driven by network state, for the remote player.
 */
export default class FishingView {
  constructor(scene) {
    this.scene = scene;
    this.line = scene.add.graphics();
    this.bobber = scene.add.sprite(0, 0, TEXTURES.VFX_BOBBER_BITE, 1).setVisible(false);
    this.mark = scene.add
      .text(0, 0, '!', { fontFamily: 'monospace', fontSize: '14px', fontStyle: 'bold', color: '#ffe14d', stroke: '#000000', strokeThickness: 3 })
      .setOrigin(0.5, 1)
      .setResolution(4)
      .setVisible(false);
    this.flight = null;
    this.visible = false;
    this.time = 0;
  }

  /** Throw the bobber from the rod tip to the landing point; it splashes down at the end. */
  launch(from, to, durationMs, onLand) {
    this.hide();
    this.visible = true;
    this.mode = null;
    this.pos = { x: from.x, y: from.y };
    this.target = to;
    this.flight = { from, to, t: 0, dur: durationMs, onLand };
    this.bobber.setVisible(true).setFrame(1).setPosition(from.x, from.y);
    this.bobber.anims.stop();
  }

  /** Place the bobber without a throw (e.g. the remote player joined mid-cast). */
  place(to) {
    this.hide();
    this.visible = true;
    this.mode = null;
    this.target = to;
    this.pos = { x: to.x, y: to.y };
    this.bobber.setVisible(true).setPosition(to.x, to.y);
    this.setMode('rest');
  }

  /** 'rest' | 'bite' (thrashing bobber + "!") | 'thrash' (thrashing bobber, no "!": a fish is fighting). */
  setMode(mode) {
    if (!this.visible || this.mode === mode) return;
    this.mode = mode;
    this.bobber.play(mode === 'rest' ? 'bobber_rest' : animKey(TEXTURES.VFX_BOBBER_BITE));
    this.mark.setVisible(mode === 'bite');
  }

  /** Move the landed bobber (the line is reeled in / the fish pulls it out). */
  setPosition(x, y) {
    if (!this.visible || this.flight) return;
    this.target = { x, y };
    this.bobber.setPosition(Math.round(x), Math.round(y));
  }

  update(dt, tip, head) {
    if (!this.visible) return;
    this.time += dt;
    if (this.flight) {
      const f = this.flight;
      f.t += dt * 1000;
      const p = Math.min(1, f.t / f.dur);
      this.pos = { x: f.from.x + (f.to.x - f.from.x) * p, y: f.from.y + (f.to.y - f.from.y) * p };
      this.bobber.setPosition(Math.round(this.pos.x), Math.round(this.pos.y - Math.sin(Math.PI * p) * 16));
      if (p >= 1) {
        this.flight = null;
        this.bobber.setPosition(Math.round(f.to.x), Math.round(f.to.y));
        this.splash(f.to);
        this.setMode('rest');
        f.onLand?.();
      }
    }
    this.bobber.setDepth(this.target.y);

    // Line: rod tip -> bobber (arcs with the bobber during the throw).
    this.line.clear().setDepth(this.target.y);
    this.line.lineStyle(1, 0xf4f4f4, 0.85);
    this.line.beginPath();
    this.line.moveTo(Math.round(tip.x), Math.round(tip.y));
    this.line.lineTo(this.bobber.x, this.bobber.y - 1);
    this.line.strokePath();

    if (this.mark.visible) {
      this.mark.setPosition(Math.round(head.x), Math.round(head.y - 38 - Math.abs(Math.sin(this.time * 10)) * 2));
      this.mark.setDepth(9000);
    }
  }

  splash(at) {
    const s = this.scene.add.sprite(at.x, at.y, TEXTURES.VFX_SHALLOW_STEP).setDepth(at.y + 1).setAlpha(0.9);
    s.play({ key: animKey(TEXTURES.VFX_SHALLOW_STEP), repeat: 0 });
    s.once('animationcomplete', () => s.destroy());
  }

  hide() {
    this.flight = null;
    this.visible = false;
    this.mode = null;
    this.line.clear();
    this.bobber.setVisible(false);
    this.bobber.anims.stop();
    this.mark.setVisible(false);
  }

  destroy() {
    this.line.destroy();
    this.bobber.destroy();
    this.mark.destroy();
  }
}
