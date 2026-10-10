import credits from '../data/credits.json';

const NICK_KEY = 'ft_nick';

const ERRORS = {
  NOT_FOUND: 'Room not found. Check the code.',
  ROOM_FULL: 'Room is full (max 2 players).',
  ALREADY_IN_ROOM: 'You are already in a room.',
};

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

/**
 * DOM overlay for the lobby (forms are easier and more accessible in HTML than in canvas).
 * Player-controlled strings (nicknames) are only ever inserted with textContent.
 */
export default class LobbyUI {
  /**
   * @param {import('../net/NetworkSystem.js').default} net
   * @param {{onLocal: () => void}} hooks
   */
  constructor(net, hooks) {
    this.net = net;
    this.root = document.getElementById('lobby');
    this.root.replaceChildren();

    this.nick = el('input', { maxLength: 12, placeholder: 'Nickname', value: this.savedNick(), autocomplete: 'off' });
    this.code = el('input', { maxLength: 4, placeholder: 'CODE', autocomplete: 'off', className: 'code' });
    this.error = el('p', { className: 'error' });
    this.status = el('p', { className: 'muted' });
    this.createBtn = el('button', { textContent: 'Create room', onclick: () => this.run(() => net.createRoom(this.name())) });
    this.joinBtn = el('button', {
      textContent: 'Join',
      onclick: () => this.run(() => net.joinRoom(this.code.value, this.name())),
    });
    this.home = el(
      'div', {},
      el('label', {}, 'Nickname', this.nick),
      this.createBtn,
      el('div', { className: 'row' }, this.code, this.joinBtn),
      el('button', { textContent: 'Local test (2 players, 1 keyboard)', className: 'secondary', onclick: hooks.onLocal }),
      this.error,
    );

    this.roomCode = el('b');
    this.list = el('ul');
    this.readyBtn = el('button', { onclick: () => net.setReady(!this.mine()?.ready) });
    this.hint = el('p', { className: 'muted' });
    this.roomView = el(
      'div', { hidden: true },
      el('p', {}, 'Room code: ', this.roomCode, ' - share it with your friend'),
      this.list,
      this.readyBtn,
      el('button', { textContent: 'Leave', className: 'secondary', onclick: () => net.leave() }),
      this.hint,
    );

    this.creditsBox = el('div', { className: 'credits', hidden: true }, ...credits.map((c) => el('p', {}, c.text)));
    this.creditsBtn = el('button', { textContent: 'Credits', className: 'link', onclick: () => (this.creditsBox.hidden = !this.creditsBox.hidden) });
    this.root.append(el('div', { className: 'panel' }, el('h1', {}, 'Fishing Together'), this.status, this.home, this.roomView, this.creditsBtn, this.creditsBox));
    if (net.notice) {
      this.error.textContent = net.notice; // e.g. the room we were in no longer exists
      net.notice = null;
    }
    this.setOnline(net.online);
    this.render(net.room);
  }

  show() {
    this.root.hidden = false;
  }

  hide() {
    this.root.hidden = true;
    document.activeElement?.blur?.();
  }

  setOnline(online) {
    this.status.textContent = online ? '' : 'Server offline - only local test is available.';
    this.createBtn.disabled = !online;
    this.joinBtn.disabled = !online;
  }

  render(room) {
    this.home.hidden = Boolean(room);
    this.roomView.hidden = !room;
    if (!room) return;
    this.roomCode.textContent = room.code;
    this.list.replaceChildren(
      ...room.players.map((p) =>
        el(
          'li', { className: p.pid === this.net.pid ? 'me' : '' },
          `${p.name}${p.pid === this.net.pid ? ' (you)' : ''}`,
          el('span', { className: p.ready ? 'ok' : 'muted', textContent: !p.connected ? 'offline' : p.ready ? 'ready' : 'not ready' }),
        ),
      ),
    );
    this.readyBtn.textContent = this.mine()?.ready ? 'Cancel ready' : 'Ready';
    this.hint.textContent = room.players.length < 2 ? 'Waiting for another player...' : 'Both players must press Ready.';
  }

  mine() {
    return this.net.me;
  }

  name() {
    const value = this.nick.value.trim();
    try {
      localStorage.setItem(NICK_KEY, value);
    } catch { /* private mode */ }
    return value;
  }

  savedNick() {
    try {
      return localStorage.getItem(NICK_KEY) ?? '';
    } catch {
      return '';
    }
  }

  async run(action) {
    this.error.textContent = '';
    try {
      const res = await action();
      if (!res.ok) this.error.textContent = ERRORS[res.error] ?? 'Something went wrong.';
    } catch {
      this.error.textContent = 'Server did not respond.';
    }
  }
}
