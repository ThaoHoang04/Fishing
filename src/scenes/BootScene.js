import Phaser from 'phaser';
import {
  SCENES, IMAGES, SPRITESHEETS, TEXTURES, DIRECTIONS, PLAYER_SKINS, playerKey, animKey,
} from '../constants/assetKeys.js';
import { createBoatAnims } from '../entities/Boat.js';
import hatsData from '../data/hats.json';

export default class BootScene extends Phaser.Scene {
  constructor() {
    super(SCENES.BOOT);
  }

  preload() {
    const { width, height } = this.scale;
    const style = { fontFamily: 'monospace', fontSize: '10px', color: '#ffffff' };
    this.add.text(width / 2, height / 2 - 26, 'Fishing Together', { ...style, fontSize: '14px', color: '#7fd1ff' }).setOrigin(0.5).setResolution(4);
    this.add.rectangle(width / 2, height / 2, 124, 10, 0x0b1a2e).setStrokeStyle(1, 0x4a6a96);
    const bar = this.add.rectangle(width / 2 - 60, height / 2, 0, 6, 0x7fd1ff).setOrigin(0, 0.5);
    const percent = this.add.text(width / 2, height / 2 + 16, 'Loading... 0%', style).setOrigin(0.5).setResolution(4);
    this.load.on('progress', (p) => {
      bar.width = 120 * p;
      percent.setText(`Loading... ${Math.round(p * 100)}%`);
    });
    this.failed = [];
    this.load.on('loaderror', (file) => {
      this.failed.push(file.key);
      console.error(`[assets] failed to load: ${file.key} (${file.src})`);
    });

    for (const img of IMAGES) this.load.image(img.key, img.path);
    for (const s of SPRITESHEETS) {
      this.load.spritesheet(s.key, s.path, { frameWidth: s.frameWidth, frameHeight: s.frameHeight });
    }
  }

  /** Hats are tiny pixel pictures kept as data (src/data/hats.json): paint each onto its own texture. */
  createHatTextures() {
    for (const [id, hat] of Object.entries(hatsData)) {
      const w = hat.rows[0].length;
      const tex = this.textures.createCanvas(`hat_${id}`, w, hat.rows.length);
      const ctx = tex.getContext();
      hat.rows.forEach((row, y) => [...row].forEach((c, x) => {
        if (!hat.palette[c]) return;
        ctx.fillStyle = hat.palette[c];
        ctx.fillRect(x, y, 1, 1);
      }));
      tex.refresh();
    }
  }

  create() {
    this.createHatTextures();
    if (this.failed.length > 0) return this.showLoadError();
    this.createFrames();
    this.createDockTexture();
    this.createStallTexture();
    this.createAnimations();
    // Wait for the first connection attempt (and session rejoin) so the lobby knows whether we are online.
    const net = this.registry.get('net');
    (net ? net.connect() : Promise.resolve()).then(() => this.scene.start(SCENES.LOBBY));
  }

  /** Missing files would crash the game later in confusing ways: say so now and stop. */
  showLoadError() {
    const { width, height } = this.scale;
    const shown = this.failed.slice(0, 6).join(', ') + (this.failed.length > 6 ? ` +${this.failed.length - 6} more` : '');
    this.add.text(width / 2, height / 2 + 36, `Could not load game files:\n${shown}\n\nCheck your connection, then reload the page.`, {
      fontFamily: 'monospace', fontSize: '8px', color: '#ff8a8a', align: 'center', wordWrap: { width: width - 40 },
    }).setOrigin(0.5, 0).setResolution(4);
  }

  // fishing_spot.png (A1) holds two icons side by side; the left one has a white outline that
  // stays readable over water, the right one does not, so only the outlined icon is used.
  createFrames() {
    this.textures.get(TEXTURES.FISHING_SPOT).add('marker', 0, 0, 0, 34, 48);
  }

  // 16x16 pier plank, palette taken from A5 Pier_Tiles so it blends with the pack.
  createDockTexture() {
    const g = this.make.graphics({ x: 0, y: 0, add: false });
    g.fillStyle(0xb06a45).fillRect(0, 0, 16, 16);
    g.fillStyle(0x8c4f3c).fillRect(0, 0, 16, 1).fillRect(0, 8, 16, 1);
    g.fillStyle(0xd08a5a).fillRect(0, 1, 16, 1).fillRect(0, 9, 16, 1);
    g.fillStyle(0x6a3a38).fillRect(3, 4, 1, 1).fillRect(11, 12, 1, 1).fillRect(12, 3, 1, 1).fillRect(5, 13, 1, 1);
    g.generateTexture(TEXTURES.DOCK_PLANK, 16, 16);
    g.destroy();
  }

  // The market stall (48x40): striped awning, two posts, a counter with a few fish on it. Palette matches the pier.
  createStallTexture() {
    const g = this.make.graphics({ x: 0, y: 0, add: false });
    // posts + back
    g.fillStyle(0x6b4423).fillRect(3, 12, 3, 28).fillRect(42, 12, 3, 28);
    g.fillStyle(0x3b2a2a).fillRect(6, 14, 36, 14);
    // counter
    g.fillStyle(0xb06a45).fillRect(1, 26, 46, 14);
    g.fillStyle(0xd08a5a).fillRect(1, 26, 46, 2);
    g.fillStyle(0x8c4f3c).fillRect(1, 33, 46, 1).fillRect(1, 39, 46, 1);
    // goods on the counter: three little fish
    g.fillStyle(0x9fb3c8).fillRect(8, 22, 8, 4).fillRect(16, 23, 2, 2);
    g.fillStyle(0xf2a65a).fillRect(22, 22, 8, 4).fillRect(30, 23, 2, 2);
    g.fillStyle(0x7fd1ff).fillRect(35, 22, 7, 4).fillRect(42, 23, 2, 2);
    g.fillStyle(0x000000).fillRect(9, 23, 1, 1).fillRect(23, 23, 1, 1).fillRect(36, 23, 1, 1);
    // awning
    for (let i = 0; i < 8; i++) {
      g.fillStyle(i % 2 ? 0xf5f0e6 : 0xd94f4f).fillRect(i * 6, 3, 6, 10);
      g.fillStyle(i % 2 ? 0xf5f0e6 : 0xd94f4f).fillRect(i * 6 + 1, 13, 4, 2); // scalloped edge
    }
    g.fillStyle(0x000000, 0.25).fillRect(0, 12, 48, 1);
    g.generateTexture(TEXTURES.SHOP_STALL, 48, 40);
    g.destroy();
  }

  createAnimations() {
    // Character sheets: 4 frames per row, one row per direction.
    const charAnims = [
      { action: 'idle', frameRate: 4, repeat: -1 },
      { action: 'walk', frameRate: 8, repeat: -1 },
      { action: 'fish', frameRate: 8, repeat: 0 },
    ];
    for (const skin of PLAYER_SKINS) {
      for (const { action, frameRate, repeat } of charAnims) {
        const key = playerKey(skin, action);
        DIRECTIONS.forEach((dir, row) => {
          this.anims.create({
            key: animKey(key, dir),
            frames: this.anims.generateFrameNumbers(key, { start: row * 4, end: row * 4 + 3 }),
            frameRate,
            repeat,
          });
        });
      }
    }

    createBoatAnims(this.anims);

    // Bobber floating calmly: the resting frames of the A6 bobber sheet, slowly cycled.
    this.anims.create({
      key: 'bobber_rest',
      frames: [1, 5, 9, 13, 9, 5].map((frame) => ({ key: TEXTURES.VFX_BOBBER_BITE, frame })),
      frameRate: 3,
      repeat: -1,
    });

    // A6 VFX: 16 frames @ 16 FPS, centered.
    for (const key of [TEXTURES.VFX_BOBBER_BITE, TEXTURES.VFX_CALM_RIPPLE, TEXTURES.VFX_SHALLOW_STEP]) {
      this.anims.create({ key: animKey(key), frames: this.anims.generateFrameNumbers(key, { start: 0, end: 15 }), frameRate: 16, repeat: -1 });
    }
  }
}
