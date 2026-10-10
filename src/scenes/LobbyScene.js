import Phaser from 'phaser';
import { SCENES } from '../constants/assetKeys.js';
import LobbyUI from '../ui/lobbyUI.js';

// Create / join a room and wait for both players to press Ready. The form itself is a DOM overlay.
export default class LobbyScene extends Phaser.Scene {
  constructor() {
    super(SCENES.LOBBY);
  }

  create() {
    const net = this.registry.get('net');
    this.add.rectangle(0, 0, this.scale.width, this.scale.height, 0x1b2430).setOrigin(0);

    const ui = new LobbyUI(net, { onLocal: () => this.startGame('local') });
    ui.show();

    const onRoom = (room) => {
      ui.render(room);
      if (room?.phase === 'playing') this.startGame('online');
    };
    const onStatus = (online) => ui.setOnline(online);
    net.on('room', onRoom);
    net.on('status', onStatus);
    this.events.once('shutdown', () => {
      net.off('room', onRoom);
      net.off('status', onStatus);
    });

    this.ui = ui;
    onRoom(net.room); // e.g. page reload while a game was running: go straight back in
  }

  startGame(mode) {
    this.ui.hide();
    // Always through the map loader: it streams in whatever the player's map needs (nothing, for the lake).
    const mapId = mode === 'online' ? this.registry.get('net').me?.mapId ?? 'lake' : 'lake';
    this.scene.start(SCENES.LOAD_MAP, { mode, mapId });
  }
}
