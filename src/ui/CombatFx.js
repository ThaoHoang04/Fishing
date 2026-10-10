const STAR_COUNT = 3;

/** Cartoon feedback for fights: a word that pops up over the attacker, and stars circling a dizzy head. */
export default class CombatFx {
  constructor(scene) {
    this.scene = scene;
    this.pops = new Set();
    this.dizzy = new Map(); // anchor -> {until, stars}
    this.buoys = new Map(); // anchor -> {until, g}
    this.flying = new Set(); // thrown fish in the air: {sprite, born, x, y, vx, vy, ttl}
  }

  /** @param {{sprite: {x: number, y: number}}} anchor  a Player or RemotePlayer */
  pop(anchor, word, color = '#ffffff') {
    if (!anchor?.sprite?.active) return;
    const t = this.scene.add
      .text(Math.round(anchor.sprite.x), Math.round(anchor.sprite.y) - 44, word, {
        fontFamily: 'sans-serif', fontSize: '10px', fontStyle: 'bold', color, stroke: '#000000', strokeThickness: 3,
      })
      .setOrigin(0.5, 1)
      .setResolution(4)
      .setDepth(9900);
    this.pops.add(t);
    this.scene.tweens.add({
      targets: t, y: t.y - 16, alpha: 0, duration: 800, ease: 'Cubic.easeOut',
      onComplete: () => { this.pops.delete(t); t.destroy(); },
    });
  }

  /** Stars around the head for `ms`. */
  stars(anchor, ms) {
    this.clearStars(anchor);
    const stars = Array.from({ length: STAR_COUNT }, () =>
      this.scene.add.text(0, 0, '*', { fontFamily: 'sans-serif', fontSize: '12px', fontStyle: 'bold', color: '#ffe14d', stroke: '#8a5a00', strokeThickness: 2 })
        .setOrigin(0.5).setResolution(4).setDepth(9900));
    this.dizzy.set(anchor, { until: this.scene.time.now + ms, stars });
  }

  /** A thrown fish or piece of junk, flying along its path (the server decides if it hits). */
  fly(shot, frame) {
    const sprite = this.scene.add.image(shot.x, shot.y, 'fish_icons_16', frame).setDepth(9950).setScale(1.5);
    const v = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[shot.facing] ?? [0, 1];
    this.flying.add({ sprite, born: this.scene.time.now, x: shot.x, y: shot.y, vx: v[0] * shot.speed, vy: v[1] * shot.speed, ttl: shot.ttlMs });
    this.scene.sfx?.play('throw');
  }

  /** A lifebuoy ring bobbing around a swimmer, for `ms`. */
  buoy(anchor, ms) {
    this.clearBuoy(anchor);
    this.buoys.set(anchor, { until: this.scene.time.now + ms, g: this.scene.add.graphics().setDepth(9899) });
  }

  clearBuoy(anchor) {
    this.buoys.get(anchor)?.g.destroy();
    this.buoys.delete(anchor);
  }

  clearStars(anchor) {
    this.dizzy.get(anchor)?.stars.forEach((s) => s.destroy());
    this.dizzy.delete(anchor);
  }

  update() {
    const now = this.scene.time.now;
    for (const f of [...this.flying]) {
      const t = now - f.born;
      if (t > f.ttl) {
        f.sprite.destroy();
        this.flying.delete(f);
        continue;
      }
      f.sprite.setPosition(Math.round(f.x + (f.vx * t) / 1000), Math.round(f.y + (f.vy * t) / 1000)).setAngle(t * 1.2);
    }
    for (const [anchor, b] of this.buoys) {
      if (now > b.until || !anchor.sprite?.active) {
        this.clearBuoy(anchor);
        continue;
      }
      const bob = Math.sin(now / 200) * 1.5;
      const x = Math.round(anchor.sprite.x);
      const y = Math.round(anchor.sprite.y) - 6 + bob;
      b.g.clear();
      b.g.lineStyle(3, 0xff7b3a, 1).strokeEllipse(x, y, 22, 11);
      b.g.lineStyle(2, 0xffffff, 1).strokeEllipse(x, y, 22, 11).setAlpha(0.9);
    }
    for (const [anchor, d] of this.dizzy) {
      if (now > d.until || !anchor.sprite?.active) {
        this.clearStars(anchor);
        continue;
      }
      d.stars.forEach((s, i) => {
        const a = now / 160 + (i * Math.PI * 2) / STAR_COUNT;
        s.setPosition(Math.round(anchor.sprite.x + Math.cos(a) * 8), Math.round(anchor.sprite.y - 34 + Math.sin(a) * 3));
      });
    }
  }

  destroy() {
    for (const anchor of [...this.dizzy.keys()]) this.clearStars(anchor);
    for (const anchor of [...this.buoys.keys()]) this.clearBuoy(anchor);
    for (const f of this.flying) f.sprite.destroy();
    this.flying.clear();
    for (const t of this.pops) t.destroy();
    this.pops.clear();
  }
}
