// Floating nickname above a character. Colour is per slot so the two players are easy to tell apart.
export const SLOT_COLORS = ['#7fd1ff', '#ffb86b'];

export default class NameTag {
  constructor(scene, name, color = '#ffffff') {
    this.text = scene.add
      .text(0, 0, name, { fontFamily: 'monospace', fontSize: '8px', color, stroke: '#000000', strokeThickness: 2 })
      .setOrigin(0.5, 1)
      .setResolution(4);
  }

  /** Place above a sprite whose feet are at (x, y). */
  place(x, y) {
    this.text.setPosition(x, y - 17).setDepth(5000 + y);
  }

  setText(value) {
    this.text.setText(value);
  }

  setAlpha(a) {
    this.text.setAlpha(a);
  }

  destroy() {
    this.text.destroy();
  }
}
