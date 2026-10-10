import { TEXTURES } from '../constants/assetKeys.js';
import { RARITY_STYLE, formatWeight } from './rarity.js';

const CX = 392; // right side of the 480x270 canvas: the camera keeps the player in the middle, so never cover it
const TOP = 26;
const W = 150;
const H = 106;
const HOLD_MS = 2400;

/** The "you caught it" card: sprite, name, rarity and weight. Screen-space, shown to the catcher. */
export default class CatchCard {
  constructor(scene) {
    this.scene = scene;
    this.g = scene.add.graphics();
    const text = (size, color = '#ffffff', bold = false) =>
      scene.add.text(CX, 0, '', { fontFamily: 'monospace', fontSize: size, color, fontStyle: bold ? 'bold' : 'normal', stroke: '#000000', strokeThickness: 2 })
        .setOrigin(0.5, 0).setResolution(4);
    this.title = text('8px', '#ffe14d', true).setY(TOP + 5);
    this.icon = scene.add.image(CX, TOP + 40, TEXTURES.FISH_ICONS, 0).setScale(3);
    this.name = text('10px', '#ffffff', true).setY(TOP + 66);
    this.rarity = text('8px').setY(TOP + 79);
    this.weight = text('9px', '#ffffff').setY(TOP + 91);
    this.items = [this.g, this.title, this.icon, this.name, this.rarity, this.weight];
    for (const o of this.items) o.setScrollFactor(0).setDepth(10010).setVisible(false);
    this.hideTimer = null;
  }

  /** @param {{name: string, rarity: string, icon: number}} species  @param {number} weight kg  @param {{isNew?: boolean, record?: boolean}} flags */
  show(species, weight, { isNew = false, record = false, boss = false, trash = false, fake = false, chest = false, coop = false, giant = false, coins = 0 } = {}) {
    const style = RARITY_STYLE[species.rarity];
    const g = this.g.clear();
    g.fillStyle(0x0b1a2e, 0.92).fillRect(CX - W / 2, TOP, W, H);
    g.lineStyle(2, style.hex, 1).strokeRect(CX - W / 2 + 1, TOP + 1, W - 2, H - 2);
    // soft glow behind the fish
    g.fillStyle(style.hex, 0.16).fillCircle(CX, TOP + 40, 28);

    this.title
      .setText(coop ? `${giant ? 'GIANT LANDED!' : 'BOSS DEFEATED!'} +${coins} coins` : chest ? 'TREASURE CHEST!' : fake ? 'LEGENDARY?! ...JUNK!' : trash ? 'JUNK' : boss ? 'BOSS DEFEATED!' : isNew ? 'NEW SPECIES!' : record ? 'NEW RECORD!' : 'CAUGHT!')
      .setColor(chest ? '#ffd166' : fake || trash ? '#9aa7b5' : boss ? '#ff6b6b' : isNew ? '#7fd1ff' : '#ffe14d');
    this.icon.setFrame(species.icon);
    this.name.setText(species.name);
    this.rarity.setText(style.label.toUpperCase()).setColor(style.color);
    this.weight.setText(formatWeight(weight));

    for (const o of this.items) o.setVisible(true).setAlpha(1);
    this.scene.tweens.killTweensOf(this.icon);
    this.icon.setScale(1.2);
    this.scene.tweens.add({ targets: this.icon, scale: 3, duration: 260, ease: 'Back.Out' });

    this.hideTimer?.remove();
    this.hideTimer = this.scene.time.delayedCall(HOLD_MS, () => this.fadeOut());
  }

  fadeOut() {
    this.scene.tweens.add({
      targets: this.items,
      alpha: 0,
      duration: 300,
      onComplete: () => this.hide(),
    });
  }

  hide() {
    this.hideTimer?.remove();
    this.hideTimer = null;
    this.scene.tweens.killTweensOf(this.items);
    this.g.clear();
    for (const o of this.items) o.setVisible(false);
  }

  get visible() {
    return this.title.visible;
  }

  destroy() {
    this.hide();
    for (const o of this.items) o.destroy();
  }
}
