/**
 * On-screen controls for phones and tablets. They do not talk to the game at all: they press and release the same
 * keyboard keys the game already listens to (WASD to walk or sail, SPACE to fish and reel, B / E / I ...), so every feature
 * works the same by touch. A stick on the left, the main buttons on the right, and a "more" panel for the rarer keys.
 */
const KEYS = {
  W: ['KeyW', 87], A: ['KeyA', 65], S: ['KeyS', 83], D: ['KeyD', 68], SPACE: ['Space', 32], ESC: ['Escape', 27], ENTER: ['Enter', 13],
  X: ['KeyX', 88], E: ['KeyE', 69], I: ['KeyI', 73], B: ['KeyB', 66], V: ['KeyV', 86], M: ['KeyM', 77], F: ['KeyF', 70],
  J: ['KeyJ', 74], K: ['KeyK', 75], L: ['KeyL', 76], H: ['KeyH', 72], Z: ['KeyZ', 90], R: ['KeyR', 82], G: ['KeyG', 71],
  T: ['KeyT', 84], C: ['KeyC', 67], O: ['KeyO', 79], P: ['KeyP', 80], U: ['KeyU', 85], Y: ['KeyY', 89], N: ['KeyN', 78],
  1: ['Digit1', 49], 2: ['Digit2', 50], 3: ['Digit3', 51], 4: ['Digit4', 52],
};
const KEY_NAME = { SPACE: ' ', ESC: 'Escape', ENTER: 'Enter' };

/** Press (down = true) or release a key as if it were typed. */
export function sendKey(name, down) {
  const [code, keyCode] = KEYS[name];
  const init = { key: KEY_NAME[name] ?? name.toLowerCase(), code, keyCode, which: keyCode, bubbles: true, cancelable: true };
  window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', init));
}

/** Stick direction from a drag offset: which of W/A/S/D are held (a dead zone in the middle; diagonals allowed). */
export function stickKeys(dx, dy, dead = 14) {
  const held = new Set();
  if (Math.hypot(dx, dy) < dead) return held;
  const angle = Math.atan2(dy, dx); // 0 = right, +90deg = down
  const part = (a) => Math.cos(angle - a);
  if (part(0) > 0.38) held.add('D');
  if (part(Math.PI) > 0.38) held.add('A');
  if (part(Math.PI / 2) > 0.38) held.add('S');
  if (part(-Math.PI / 2) > 0.38) held.add('W');
  return held;
}

// The main buttons: the big FISH button bottom-right, four small ones in a 2x2 block to its left and above (right/bottom offsets, px).
const MAIN = [
  { key: 'SPACE', label: '\u{1F3A3}', name: 'Fish / reel', big: true },
  { key: 'B', label: '\u26F5', name: 'Boat', at: [104, 0] },
  { key: 'E', label: '\u{1F6D2}', name: 'Market', at: [104, 50] },
  { key: 'I', label: '\u{1F392}', name: 'Bag', at: [0, 104] },
  { key: 'X', label: '\u270B', name: 'Let go', at: [50, 104] },
];
const MORE = [
  ['F', '\u{1F94A}', 'Fight / friendly'], ['J', '\u{1F44B}', 'Slap'], ['K', '\u{1F44A}', 'Push'], ['L', '\u{1F528}', 'Bonk'],
  ['H', '\u{1F4A5}', 'Big push'], ['Z', '\u{1F41F}', 'Throw a fish'], ['R', '\u{1F198}', 'Rescue'], ['G', '\u{1F91D}', 'Grab the lifebuoy'],
  ['T', '\u{1F608}', 'Steal'], ['C', '\u{1F426}', 'Shoo the seagull'], ['O', '\u{1F9F0}', 'Open the chest'], ['P', '\u{1F4F7}', 'Photo'],
  ['U', '\u2694\uFE0F', 'Duel'], ['Y', '\u2705', 'Yes'], ['N', '\u274C', 'No'], ['V', '\u{1F501}', 'Swap seats'],
  ['1', '\u{1F64B}', 'Hi!'], ['2', '\u{1F44D}', 'Nice!'], ['3', '\u{1F62E}', 'Wow!'], ['4', '\u2764\uFE0F', 'Love'], ['M', '\u{1F50A}', 'Sound'], ['ESC', '\u2B05\uFE0F', 'Back'],
];

const CSS = `
#touch { position: fixed; inset: 0; z-index: 3; pointer-events: none; font: 700 13px/1 sans-serif; color: #fff; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; touch-action: none; }
#touch[hidden] { display: none; }
#chat .hint { display: none; }
#touch * { touch-action: none; -webkit-tap-highlight-color: transparent; }
#touch .stick { position: absolute; left: max(18px, env(safe-area-inset-left)); bottom: max(18px, env(safe-area-inset-bottom)); width: 128px; height: 128px; border-radius: 50%;
  background: rgba(20, 34, 54, .45); border: 2px solid rgba(255,255,255,.35); pointer-events: auto; }
#touch .stick i { position: absolute; left: 50%; top: 50%; width: 54px; height: 54px; margin: -27px 0 0 -27px; border-radius: 50%; background: rgba(127, 209, 255, .7); border: 2px solid #fff; }
#touch button { pointer-events: auto; border: 2px solid rgba(255,255,255,.55); background: rgba(20, 34, 54, .62); color: #fff; font: inherit; font-size: 22px; line-height: 1; border-radius: 12px; min-width: 54px; height: 44px; padding: 0 8px; }
#touch button.on { background: rgba(58, 123, 213, .9); }
#touch .main { position: absolute; right: max(14px, env(safe-area-inset-right)); bottom: max(14px, env(safe-area-inset-bottom)); width: 190px; height: 190px; }
#touch .main button { position: absolute; width: 50px; }
#touch .main button.big { right: 0; bottom: 0; width: 92px; height: 92px; border-radius: 50%; font-size: 42px; background: rgba(47, 158, 87, .75); }
#touch .top { position: absolute; left: 50%; transform: translateX(-50%); top: max(8px, env(safe-area-inset-top)); display: flex; gap: 6px; }
body.fighting #touch .top button[data-key="F"] { background: rgba(196, 75, 90, .9); }
#touch .more { position: absolute; right: 10px; bottom: 218px; display: grid; grid-template-columns: repeat(4, 62px); gap: 6px; padding: 8px; background: rgba(10, 20, 36, .85); border-radius: 12px; pointer-events: auto; }
#touch .more[hidden] { display: none; }
@media (max-height: 420px) {
  #touch .stick { width: 104px; height: 104px; }
  #touch .main { width: 160px; height: 160px; }
  #touch .main button.big { width: 80px; height: 80px; }
  #touch .more { bottom: 14px; right: 190px; grid-template-columns: repeat(6, 54px); }
  #touch .more button { min-width: 0; height: 38px; padding: 0; }
}
`;

export default class TouchControls {
  constructor() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.append(style);
    this.root = document.createElement('div');
    this.root.id = 'touch';
    this.root.hidden = true;
    this.held = new Set();

    this.stick = document.createElement('div');
    this.stick.className = 'stick';
    this.knob = document.createElement('i');
    this.stick.append(this.knob);
    this.#bindStick();

    const main = document.createElement('div');
    main.className = 'main';
    for (const b of MAIN) {
      const node = this.#button(b.key, b.label, b.big, b.name);
      if (b.big) node.className = 'big';
      else [node.style.right, node.style.bottom] = b.at.map((n) => `${n}px`);
      main.append(node);
    }

    const top = document.createElement('div');
    top.className = 'top';
    this.panel = document.createElement('div');
    this.panel.className = 'more';
    this.panel.hidden = true;
    for (const [key, label, name] of MORE) this.panel.append(this.#button(key, label, false, name));
    const more = document.createElement('button');
    more.type = 'button';
    more.textContent = '\u2630';
    more.title = 'More actions';
    more.ariaLabel = 'More actions';
    more.addEventListener('click', () => {
      this.panel.hidden = !this.panel.hidden;
      more.classList.toggle('on', !this.panel.hidden);
    });
    // The FIGHT button only switches the mode (key F); the attack buttons come from the combat hud while it is on.
    top.append(this.#button('ENTER', '\u{1F4AC}', false, 'Chat'), this.#button('F', '\u{1F94A}', false, 'Fight / friendly'), more);

    this.root.append(this.stick, main, top, this.panel);
    document.body.append(this.root);
    this.timer = setInterval(() => this.#sync(), 250);
  }

  /** A button that presses `key`: held for as long as the finger is down (SPACE) or a quick tap (everything else). */
  #button(key, label, hold = false, name = '') {
    const node = document.createElement('button');
    node.type = 'button';
    node.textContent = label;
    node.dataset.key = key;
    if (name) {
      node.title = name;
      node.ariaLabel = name;
    }
    node.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      node.setPointerCapture?.(e.pointerId);
      node.classList.add('on');
      sendKey(key, true);
      if (!hold) setTimeout(() => sendKey(key, false), 60);
    });
    const up = (e) => {
      e.preventDefault();
      node.classList.remove('on');
      if (hold) sendKey(key, false);
    };
    node.addEventListener('pointerup', up);
    node.addEventListener('pointercancel', up);
    node.addEventListener('contextmenu', (e) => e.preventDefault());
    return node;
  }

  #bindStick() {
    const radius = 64;
    let pointer = null;
    const apply = (e) => {
      const r = this.stick.getBoundingClientRect();
      let dx = e.clientX - (r.left + r.width / 2);
      let dy = e.clientY - (r.top + r.height / 2);
      const len = Math.hypot(dx, dy);
      if (len > radius) {
        dx = (dx / len) * radius;
        dy = (dy / len) * radius;
      }
      this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
      this.#hold(stickKeys(dx, dy));
    };
    this.stick.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      pointer = e.pointerId;
      this.stick.setPointerCapture(pointer);
      apply(e);
    });
    this.stick.addEventListener('pointermove', (e) => e.pointerId === pointer && apply(e));
    const end = (e) => {
      if (e.pointerId !== pointer) return;
      pointer = null;
      this.knob.style.transform = '';
      this.#hold(new Set());
    };
    this.stick.addEventListener('pointerup', end);
    this.stick.addEventListener('pointercancel', end);
  }

  /** Make the set of held direction keys equal `next`, sending only the changes. */
  #hold(next) {
    for (const k of this.held) if (!next.has(k)) sendKey(k, false);
    for (const k of next) if (!this.held.has(k)) sendKey(k, true);
    this.held = next;
  }

  /** Only while playing: not in the lobby, not while the shop or the chat box is open (they have their own buttons). */
  #sync() {
    const hide = !document.getElementById('lobby')?.hidden || !document.getElementById('shop')?.hidden || document.getElementById('chat')?.classList.contains('open');
    if (this.root.hidden !== hide) {
      this.root.hidden = hide;
      if (hide) this.#hold(new Set());
    }
  }
}

/** Phones and tablets (a touch screen as the main pointer), or `?touch=1` to try it on a computer. */
export const wantsTouch = () => new URLSearchParams(location.search).get('touch') === '1' || window.matchMedia?.('(pointer: coarse)').matches === true;
