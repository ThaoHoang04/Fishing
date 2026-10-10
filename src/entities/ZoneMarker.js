/**
 * A circle of sea where fish bite (a "zone" in spots.json). The boat can cast in any direction from inside it.
 * The legendary zone is drawn in gold. Used as the fishing "spot" object for FishingSystem (id, x, y, type).
 */
export default class ZoneMarker {
  constructor(scene, data) {
    this.scene = scene;
    Object.assign(this, { id: data.id, x: data.x, y: data.y, r: data.r, type: 'zone', name: data.name ?? data.id, legendary: Boolean(data.legendary) });
    this.color = this.legendary ? 0xffd166 : 0x7fd1ff;
    this.g = scene.add.graphics().setDepth(-60);
    this.label = scene.add
      .text(this.x, this.y - this.r - 2, `${this.legendary ? '* ' : ''}${this.name}${this.legendary ? '  (after dark)' : ''}`, {
        fontFamily: 'monospace', fontSize: '8px', color: this.legendary ? '#ffd166' : '#cfe9ff', stroke: '#06223a', strokeThickness: 2,
      })
      .setOrigin(0.5, 1)
      .setResolution(4)
      .setDepth(-59)
      .setAlpha(0.8);
    this.active = false;
    this.time = Math.random() * 6;
    this.draw(0);
  }

  distanceTo(px, py) {
    return Math.hypot(px - this.x, py - this.y);
  }

  contains(px, py) {
    return this.distanceTo(px, py) <= this.r;
  }

  /** @param {boolean} inside a boat is in the zone right now */
  update(dt, inside) {
    this.time += dt;
    this.active = inside;
    this.draw(Math.sin(this.time * 2) * 0.5 + 0.5);
    this.label.setAlpha(inside ? 1 : 0.7);
  }

  draw(pulse) {
    const g = this.g.clear();
    const a = this.active ? 0.75 + pulse * 0.2 : 0.4 + pulse * 0.1;
    g.fillStyle(this.color, this.active ? 0.14 : 0.07).fillCircle(this.x, this.y, this.r);
    g.lineStyle(2, this.color, a).strokeCircle(this.x, this.y, this.r);
    g.lineStyle(1, this.color, a * 0.5).strokeCircle(this.x, this.y, this.r - 6 - pulse * 3);
  }

  destroy() {
    this.g.destroy();
    this.label.destroy();
  }
}
