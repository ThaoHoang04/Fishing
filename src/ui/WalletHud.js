import { TEXTURES } from '../constants/assetKeys.js';

/** Top-right corner: coins and how full the bag is. Coins pop and show "+N" when they go up. */
export default class WalletHud {
  constructor(scene) {
    this.scene = scene;
    const style = (color) => ({ fontFamily: 'monospace', fontSize: '8px', color, stroke: '#000000', strokeThickness: 2 });
    this.panel = scene.add.rectangle(476, 3, 74, 22, 0x000000, 0.45).setOrigin(1, 0).setScrollFactor(0).setDepth(9990);
    this.coinIcon = scene.add.image(414, 9, TEXTURES.UI_COIN).setScale(1.6).setScrollFactor(0).setDepth(9991);
    this.coin = scene.add.text(472, 4, '0', style('#ffe14d')).setOrigin(1, 0).setResolution(4).setScrollFactor(0).setDepth(9991);
    this.bag = scene.add.text(472, 20, 'Bag 0/20', style('#cfe6ff')).setOrigin(1, 0).setResolution(4).setScrollFactor(0).setDepth(9991);
    this.last = null;
  }

  update(state) {
    if (!state) return;
    this.coin.setText(String(state.coin));
    const full = state.items.length >= state.capacity;
    this.bag.setText(`Bag ${state.items.length}/${state.capacity}`).setColor(full ? '#ff8a8a' : '#cfe6ff');
    if (this.last !== null && state.coin > this.last) this.celebrate(state.coin - this.last);
    this.last = state.coin;
  }

  celebrate(gain) {
    const t = this.scene.add
      .text(472, 50, `+${gain}`, { fontFamily: 'monospace', fontSize: '10px', color: '#7be08a', stroke: '#000000', strokeThickness: 2 })
      .setOrigin(1, 0).setResolution(4).setScrollFactor(0).setDepth(9992);
    this.scene.tweens.add({ targets: t, y: 40, alpha: 0, duration: 1100, onComplete: () => t.destroy() });
    this.scene.tweens.add({ targets: this.coin, scale: 1.4, duration: 120, yoyo: true });
  }

  destroy() {
    for (const o of [this.panel, this.coinIcon, this.coin, this.bag]) o.destroy();
  }
}
