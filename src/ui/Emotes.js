import emotes from '../data/emotes.json';

const SHOW_MS = 2400;
const FADE_MS = 300;

/** Speech bubbles over a character. One bubble per character: a new emote replaces the old one. */
export default class Emotes {
  constructor(scene) {
    this.scene = scene;
    this.bubbles = new Map(); // anchor -> {text, born}
  }

  /** @param {{sprite: {x: number, y: number}}} anchor  a Player or RemotePlayer  @param {number} id index into emotes.json */
  show(anchor, id) {
    const def = emotes[id];
    if (!def) return;
    this.bubbles.get(anchor)?.text.destroy();
    const heart = def.text === '<3';
    const text = this.scene.add
      .text(0, 0, heart ? '<3' : def.text, {
        fontFamily: 'monospace', fontSize: '9px', fontStyle: 'bold', color: heart ? '#e63946' : '#1d3557',
        backgroundColor: '#ffffff', padding: { x: 5, y: 2 },
      })
      .setOrigin(0.5, 1)
      .setResolution(4)
      .setDepth(9800);
    this.bubbles.set(anchor, { text, born: this.scene.time.now });
  }

  update() {
    const now = this.scene.time.now;
    for (const [anchor, b] of this.bubbles) {
      const age = now - b.born;
      if (age > SHOW_MS + FADE_MS || !anchor.sprite?.active) {
        b.text.destroy();
        this.bubbles.delete(anchor);
        continue;
      }
      const bob = Math.round(Math.sin(age / 140) * 1.5);
      b.text.setPosition(Math.round(anchor.sprite.x), Math.round(anchor.sprite.y) - 30 + bob);
      b.text.setAlpha(age > SHOW_MS ? 1 - (age - SHOW_MS) / FADE_MS : 1);
    }
  }

  destroy() {
    for (const b of this.bubbles.values()) b.text.destroy();
    this.bubbles.clear();
  }
}
