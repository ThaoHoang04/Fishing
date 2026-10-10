import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT } from './config.js';
import BootScene from './scenes/BootScene.js';
import LobbyScene from './scenes/LobbyScene.js';
import LoadMapScene from './scenes/LoadMapScene.js';
import GameScene from './scenes/GameScene.js';
import NetworkSystem from './net/NetworkSystem.js';
import Sfx from './audio/Sfx.js';
import Music from './audio/Music.js';
import musicData from './data/music.json';
import TouchControls, { wantsTouch } from './ui/TouchControls.js';
import { installGlobalHandlers } from './ui/errorToast.js';

// The game is drawn at 480x270 and scaled up, so small monospace text turns blurry. Every in-game text gets a larger,
// clearer font and is rasterised at a high resolution (crisp when scaled).
const TEXT_SCALE = 1.3;
const makeText = Phaser.GameObjects.GameObjectFactory.prototype.text;
Phaser.GameObjects.GameObjectFactory.prototype.text = function (x, y, content, style = {}) {
  const px = parseFloat(style.fontSize ?? '16');
  const readable = { ...style, fontFamily: '"Trebuchet MS", Verdana, Arial, sans-serif', fontSize: `${Math.round(px * TEXT_SCALE)}px` };
  if (readable.stroke && readable.strokeThickness) readable.strokeThickness = Math.max(readable.strokeThickness, 3);
  if (!readable.fontStyle) readable.fontStyle = 'bold';
  return makeText.call(this, x, y, content, readable).setResolution(4);
};

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  backgroundColor: '#1b2430',
  pixelArt: true, // nearest-neighbor filtering, no antialias
  roundPixels: true,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [BootScene, LobbyScene, LoadMapScene, GameScene],
});

const net = new NetworkSystem();
game.registry.set('net', net);

// Browsers only start audio after a gesture: the first key press or click unlocks it.
const sfx = new Sfx();
game.registry.set('sfx', sfx);
game.registry.set('music', new Music(sfx, { config: musicData }));
for (const type of ['pointerdown', 'keydown']) window.addEventListener(type, () => sfx.unlock(), { passive: true });
installGlobalHandlers();
if (wantsTouch()) new TouchControls();

if (import.meta.env.DEV) Object.assign(window, { __game: game, __net: net }); // debug/test hook
