import quickChat from '../data/quickchat.json';
import { CHAT_MAX } from '../systems/ChatRules.js';

const LOG_LINES = 6; // visible when the box is closed
const LOG_KEEP = 40; // kept for scrolling while the box is open
const LINE_SHOW_MS = 9000;
const SLOT_COLORS = ['#7fd1ff', '#ffb86b'];
const ERRORS = {
  TOO_FAST: 'Slow down a little.',
  EMPTY: 'Nothing to send.',
  NOT_PLAYING: 'Chat works once the game has started.',
  NO_CONNECTION: 'No connection to the server.',
};

/**
 * Chat panel (HTML, bottom-left): the last few messages fade after a while; Enter opens the input with quick-chat
 * buttons; Enter sends, Esc closes. While it is open the game ignores the keyboard.
 */
export default class ChatUI {
  /**
   * @param {{send: (text: string) => Promise<{ok: boolean, error?: string}>, onOpen: () => void, onClose: () => void}} opts
   */
  constructor({ send, onOpen, onClose }) {
    this.send = send;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.isOpen = false;
    this.closedAt = 0;
    this.lines = []; // {node, at}

    this.root = document.createElement('div');
    this.root.id = 'chat';
    this.log = document.createElement('div');
    this.log.className = 'log';
    this.form = document.createElement('div');
    this.form.className = 'form';
    this.form.hidden = true;
    this.quick = document.createElement('div');
    this.quick.className = 'quick';
    for (const phrase of quickChat) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = phrase;
      b.addEventListener('click', () => this.submit(phrase, true));
      this.quick.append(b);
    }
    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.maxLength = CHAT_MAX;
    this.input.placeholder = `Say something (${CHAT_MAX} characters max), Enter to send`;
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    this.count = document.createElement('small');
    this.input.addEventListener('input', () => (this.count.textContent = `${this.input.value.length}/${CHAT_MAX}`));
    this.input.addEventListener('keydown', (e) => {
      if (e.isComposing) return; // Vietnamese/IME: Enter confirms the word, it does not send
      if (e.key === 'Enter') {
        e.preventDefault();
        this.submit(this.input.value, false);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
    });
    this.msg = document.createElement('small');
    this.msg.className = 'err';
    const buttons = document.createElement('div'); // for touch screens, where there is no Enter or Esc key to press
    buttons.className = 'buttons';
    const sendBtn = document.createElement('button');
    sendBtn.type = 'button';
    sendBtn.textContent = 'Send';
    sendBtn.addEventListener('click', () => this.submit(this.input.value, false));
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'secondary';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', () => this.close());
    buttons.append(sendBtn, closeBtn);
    this.form.append(this.quick, this.input, this.count, this.msg, buttons);
    this.hint = document.createElement('div');
    this.hint.className = 'hint';
    this.hint.textContent = 'Enter: chat';
    this.root.append(this.log, this.form, this.hint);
    document.body.append(this.root);
    this.timer = setInterval(() => this.fade(), 1000);
  }

  open() {
    if (this.isOpen || Date.now() - this.closedAt < 250) return;
    this.isOpen = true;
    this.form.hidden = false;
    this.hint.hidden = true;
    this.root.classList.add('open');
    this.msg.textContent = '';
    this.count.textContent = `${this.input.value.length}/${CHAT_MAX}`;
    this.onOpen();
    this.input.focus();
    this.fade();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.closedAt = Date.now();
    this.form.hidden = true;
    this.hint.hidden = false;
    this.root.classList.remove('open');
    this.input.blur();
    this.onClose();
    this.fade();
  }

  async submit(raw, fromQuick) {
    const text = raw.trim();
    if (!text) return this.close();
    this.msg.textContent = '';
    let res;
    try {
      res = await this.send(text);
    } catch {
      res = { ok: false, error: 'NO_CONNECTION' };
    }
    if (!res?.ok) {
      this.msg.textContent = ERRORS[res?.error] ?? 'Could not send.';
      if (!fromQuick) this.input.focus();
      return;
    }
    this.input.value = '';
    this.close();
  }

  /** @param {{pid: string, name: string, slot: number, text: string}} m */
  add(m) {
    const line = document.createElement('div');
    const who = document.createElement('b');
    who.style.color = SLOT_COLORS[m.slot] ?? '#ffffff';
    who.textContent = `${m.name}: `;
    line.append(who, document.createTextNode(m.text)); // text nodes only: a message can never inject markup
    this.log.append(line);
    this.lines.push({ node: line, at: Date.now() });
    while (this.lines.length > LOG_KEEP) this.lines.shift().node.remove();
    this.fade();
    this.log.scrollTop = this.log.scrollHeight;
  }

  /** Closed: show only recent lines, at most LOG_LINES. Open: everything kept. */
  fade() {
    const now = Date.now();
    const recent = this.lines.filter((l) => now - l.at < LINE_SHOW_MS).slice(-LOG_LINES);
    for (const l of this.lines) l.node.hidden = !this.isOpen && !recent.includes(l);
  }

  destroy() {
    clearInterval(this.timer);
    if (this.isOpen) this.close();
    this.root.remove();
  }
}
