import Phaser from 'phaser';
import { SCENES, MAP_ASSETS, MAP_ART_FROM } from '../constants/assetKeys.js';
import { getMap } from '../data/maps.js';

/**
 * Between maps: fetch whatever the destination needs that has not been loaded yet (map streaming), show a short
 * "sailing" screen, then start the game on that map. Maps with nothing new to load pass straight through.
 * Anything that moves a player to another map goes through here, including a reload while at sea.
 */
export default class LoadMapScene extends Phaser.Scene {
  constructor() {
    super(SCENES.LOAD_MAP);
  }

  init(data) {
    this.mapId = getMap(data?.mapId) ? data.mapId : 'lake';
    this.mode = data?.mode ?? 'local';
    this.failed = [];
  }

  preload() {
    const todo = [...(MAP_ASSETS[MAP_ART_FROM[this.mapId]] ?? []), ...(MAP_ASSETS[this.mapId] ?? [])].filter((a) => !this.textures.exists(a.key));
    if (todo.length === 0) return;

    const { width, height } = this.scale;
    this.cameras.main.setBackgroundColor('#0d2a4a');
    this.add.text(width / 2, height / 2 - 14, `Sailing to ${getMap(this.mapId).name}...`, { fontFamily: 'monospace', fontSize: '12px', color: '#ffffff' })
      .setOrigin(0.5).setResolution(4);
    const bar = this.add.rectangle(width / 2 - 50, height / 2 + 6, 0, 5, 0x7fd1ff).setOrigin(0, 0.5);
    this.load.on('progress', (p) => (bar.width = 100 * p));
    this.load.on('loaderror', (file) => {
      this.failed.push(file.key);
      console.error(`[assets] failed to load: ${file.key} (${file.src})`);
    });
    for (const a of todo) this.load.spritesheet(a.key, a.path, { frameWidth: a.frameWidth, frameHeight: a.frameHeight });
  }

  create() {
    if (this.failed.length > 0) {
      const { width, height } = this.scale;
      this.add.text(width / 2, height / 2 + 24, `Could not load: ${this.failed.join(', ')}\nReload the page to try again.`, {
        fontFamily: 'monospace', fontSize: '8px', color: '#ff8a8a', align: 'center',
      }).setOrigin(0.5, 0).setResolution(4);
      return;
    }
    if (this.textures.exists('ocean_water') && !this.anims.exists('ocean_water')) {
      this.anims.create({ key: 'ocean_water', frames: this.anims.generateFrameNumbers('ocean_water', { start: 0, end: 2 }), frameRate: 3, repeat: -1 });
    }
    this.scene.start(SCENES.GAME, { mode: this.mode, mapId: this.mapId });
  }
}
