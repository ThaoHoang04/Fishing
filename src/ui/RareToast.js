import { RARITY_STYLE, formatWeight } from './rarity.js';

const SHOW_MS = 4200;
const MAX_VISIBLE = 3;
const TOP = 34;
const ROW_H = 13;

/**
 * "Alice caught a Rare Trout!" announcements for the other player's good catches.
 * Each catch has a unique id, so the same announcement is never shown twice (e.g. after a reconnect).
 */
export default class RareToast {
  constructor(scene) {
    this.scene = scene;
    this.seen = new Set();
    this.rows = [];
  }

  /**
   * @param {{key: string, name: string}} info  key = unique id of the catch, name = who caught it
   * @param {{name: string, rarity: string}} species
   * @param {number} weight kg
   * @returns {boolean} false when it was a duplicate and nothing was shown
   */
  show(info, species, weight) {
    if (this.seen.has(info.key)) return false;
    this.seen.add(info.key);

    const style = RARITY_STYLE[species.rarity];
    const article = /^[aeiou]/i.test(style.label) ? 'an' : 'a';
    const text = this.scene.add
      .text(this.scene.scale.width / 2, 0, `${info.name} caught ${article} ${style.label} ${species.name} (${formatWeight(weight)})!`, {
        fontFamily: 'monospace', fontSize: '8px', color: style.color, backgroundColor: '#000000cc', padding: { x: 5, y: 2 },
        stroke: '#000000', strokeThickness: 1,
      })
      .setOrigin(0.5, 0)
      .setResolution(4)
      .setScrollFactor(0)
      .setDepth(10020);

    this.rows.push(text);
    if (this.rows.length > MAX_VISIBLE) this.rows.shift().destroy();
    this.layout();
    this.scene.time.delayedCall(SHOW_MS, () => this.remove(text));
    return true;
  }

  remove(text) {
    const i = this.rows.indexOf(text);
    if (i === -1) return;
    this.rows.splice(i, 1);
    this.scene.tweens.add({ targets: text, alpha: 0, duration: 250, onComplete: () => text.destroy() });
    this.layout();
  }

  layout() {
    this.rows.forEach((row, i) => row.setY(TOP + i * ROW_H));
  }

  get count() {
    return this.rows.length;
  }

  destroy() {
    this.rows.forEach((r) => r.destroy());
    this.rows = [];
  }
}
