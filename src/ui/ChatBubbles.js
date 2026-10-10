const SHOW_MS = 5000; // 4-6 seconds
const FADE_MS = 400;

/** Chat bubbles over a character, above any emote. One bubble per character: a new message replaces the old one. */
export default class ChatBubbles {
  constructor(scene) {
    this.scene = scene;
    this.bubbles = new Map(); // anchor -> {text, born}
  }

  /** @param {{sprite: {x: number, y: number}}} anchor  a Player or RemotePlayer */
  show(anchor, message) {
    this.bubbles.get(anchor)?.text.destroy();
    const text = this.scene.add
      .text(0, 0, message, {
        fontFamily: 'sans-serif', fontSize: '7px', fontStyle: 'bold', color: '#14213d', align: 'center',
        backgroundColor: '#fffbe6', padding: { x: 5, y: 3 }, wordWrap: { width: 100 },
      })
      .setOrigin(0.5, 1)
      .setResolution(4)
      .setDepth(9801);
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
      b.text.setPosition(Math.round(anchor.sprite.x), Math.round(anchor.sprite.y) - 42);
      b.text.setAlpha(age > SHOW_MS ? 1 - (age - SHOW_MS) / FADE_MS : 1);
    }
  }

  destroy() {
    for (const b of this.bubbles.values()) b.text.destroy();
    this.bubbles.clear();
  }
}
