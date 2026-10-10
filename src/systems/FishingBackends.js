import Phaser from 'phaser';

/**
 * A fishing backend is where a player's cast / hook / cancel requests go, and where the
 * results ('bite', 'miss', 'fail', 'hooked', 'result') come back from. The FishingSystem does not care
 * which one it talks to:
 *   NetFishingBackend   - the game server (online mode)
 *   LocalFishingBackend - an in-browser FishingSessions (local test mode, no server)
 * Requests return Promise<{ok, ...}>.
 */
export class NetFishingBackend extends Phaser.Events.EventEmitter {
  constructor(net) {
    super();
    this.net = net;
    this.onEvent = ({ event, ...payload }) => this.emit(event, payload);
    net.on('fishing', this.onEvent);
  }

  get available() {
    return this.net.online;
  }

  cast(spotId, power, facing) {
    return this.net.request('fishing:cast', { spotId, power, facing });
  }

  hook(id) {
    return this.net.request('fishing:hook', { id });
  }

  finish(id, toggles) {
    return this.net.request('fishing:finish', { id, toggles });
  }

  cancel() {
    return this.net.request('fishing:cancel');
  }

  /** Co-op boss: the held state of the action button. */
  bossInput(held) {
    this.net.bossInput(held);
  }

  get myPid() {
    return this.net.pid;
  }

  destroy() {
    this.net.off('fishing', this.onEvent);
    this.removeAllListeners();
  }
}

export class LocalFishingBackend extends Phaser.Events.EventEmitter {
  /** @param {import('./FishingSessions.js').default} sessions  @param {string} pid  @param {() => {x:number,y:number}} getPosition */
  constructor(sessions, pid, getPosition) {
    super();
    this.sessions = sessions;
    this.pid = pid;
    this.getPosition = getPosition;
    this.available = true;
  }

  cast(spotId, power, facing) {
    const { x, y } = this.getPosition();
    return Promise.resolve(this.sessions.cast(this.pid, { spotId, power, x, y, facing, mapId: 'lake' }));
  }

  hook(id) {
    return Promise.resolve(this.sessions.hook(this.pid, id));
  }

  finish(id, toggles) {
    return Promise.resolve(this.sessions.finish(this.pid, id, toggles));
  }

  cancel() {
    return Promise.resolve(this.sessions.cancel(this.pid));
  }

  destroy() {
    this.sessions.cancel(this.pid);
    this.removeAllListeners();
  }
}
