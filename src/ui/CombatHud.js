/**
 * The fighting buttons, drawn on screen while the player is in FIGHT mode or in a duel.
 * On a phone they form a moba-style cluster in the bottom-right corner: one big basic attack with the skills in an arc around it.
 * On a computer they are a skill bar at the bottom centre, each slot showing its key. Every skill has a cooldown sweep, and the
 * big shove has an anger meter instead. The hud only draws and reports taps: the scene decides what a press does.
 */

// key -> what it is in each mode. `cd` is the cooldown in ms (the same numbers the server uses).
export const FIGHT_SKILLS = [
  { key: 'J', icon: '\u{1F44B}', name: 'Slap', basic: true },
  { key: 'K', icon: '\u{1F44A}', name: 'Push' },
  { key: 'L', icon: '\u{1F528}', name: 'Bonk' },
  { key: 'H', icon: '\u{1F4A5}', name: 'Big push', anger: true },
  { key: 'Z', icon: '\u{1F41F}', name: 'Throw', small: true },
];
export const DUEL_SKILLS = [
  { key: 'J', icon: '\u{1F44A}', name: 'Punch', basic: true },
  { key: 'K', icon: '\u{1F9B5}', name: 'Kick' },
  { key: 'L', icon: '\u{1F4A8}', name: 'Dodge' },
  { key: 'H', icon: '\u{1F300}', name: 'Shove' },
];

const CSS = `
#combat { position: fixed; inset: 0; z-index: 3; pointer-events: none; font: 700 12px/1 sans-serif; color: #fff; user-select: none; -webkit-user-select: none; touch-action: none; }
#combat[hidden] { display: none; }
#combat * { touch-action: none; -webkit-tap-highlight-color: transparent; }
#combat .skill { position: absolute; pointer-events: auto; border: 3px solid rgba(255,255,255,.7); background: rgba(122, 37, 48, .78); color: #fff; padding: 0; overflow: hidden; font: inherit; }
#combat .skill .ico { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
#combat .skill .cd { position: absolute; inset: 0; background: conic-gradient(rgba(0,0,0,.68) calc(var(--p, 0) * 360deg), transparent 0); }
#combat .skill .num { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 15px; text-shadow: 0 0 3px #000; }
#combat .skill.down { transform: scale(.93); border-color: #ffe14d; }
#combat .skill.locked { filter: saturate(.4) brightness(.8); }
#combat .skill.ready { box-shadow: 0 0 14px 3px rgba(255, 225, 77, .85); border-color: #ffe14d; }
#combat .skill .key { display: none; }
#combat .skill .label { display: none; }

/* phone: a cluster in the bottom-right corner */
#combat.touch .cluster { position: absolute; right: max(14px, env(safe-area-inset-right)); bottom: max(14px, env(safe-area-inset-bottom)); width: 0; height: 0; }
#combat.touch .skill { border-radius: 50%; }
#combat.touch .skill .ico { font-size: 26px; }
#combat.touch .skill.basic { width: 92px; height: 92px; right: 0; bottom: 0; }
#combat.touch .skill.basic .ico { font-size: 44px; }
#combat.touch .skill.s1 { width: 58px; height: 58px; right: 108px; bottom: 6px; }
#combat.touch .skill.s2 { width: 58px; height: 58px; right: 88px; bottom: 76px; }
#combat.touch .skill.s3 { width: 58px; height: 58px; right: 17px; bottom: 108px; }
#combat.touch .skill.small { width: 44px; height: 44px; right: 160px; bottom: 76px; }
#combat.touch .skill.small .ico { font-size: 20px; }
#combat.touch .mode { display: none; }
body.fighting #touch .main { display: none; }
@media (max-height: 420px) {
  #combat.touch .skill.basic { width: 78px; height: 78px; }
  #combat.touch .skill.s1 { width: 50px; height: 50px; right: 92px; bottom: 4px; }
  #combat.touch .skill.s2 { width: 50px; height: 50px; right: 74px; bottom: 62px; }
  #combat.touch .skill.s3 { width: 50px; height: 50px; right: 14px; bottom: 92px; }
  #combat.touch .skill.small { width: 40px; height: 40px; right: 136px; bottom: 62px; }
}

/* computer: a skill bar at the bottom centre */
#combat.pc .cluster { position: absolute; right: 16px; bottom: 16px; display: flex; gap: 8px; align-items: flex-end; padding: 8px 12px 10px; background: rgba(10, 20, 36, .72); border: 2px solid rgba(255,255,255,.25); border-radius: 12px; pointer-events: auto; }
#combat.pc .skill { position: relative; width: 58px; height: 58px; border-radius: 10px; }
#combat.pc .skill.basic { width: 66px; height: 66px; }
#combat.pc .skill.small { width: 46px; height: 46px; }
#combat.pc .skill .ico { font-size: 28px; padding-bottom: 8px; }
#combat.pc .skill .key { display: block; position: absolute; left: 3px; top: 2px; padding: 1px 5px; font-size: 11px; background: rgba(0,0,0,.65); border-radius: 4px; }
#combat.pc .skill .label { display: block; position: absolute; left: 0; right: 0; bottom: 2px; text-align: center; font-size: 9px; text-shadow: 0 0 3px #000; }
#combat.pc .mode { position: absolute; right: 16px; bottom: 98px; padding: 3px 10px; font-size: 11px; letter-spacing: 1px; background: rgba(122, 37, 48, .85); border-radius: 10px; white-space: nowrap; }
#combat.pc .skill.s1, #combat.pc .skill.s2, #combat.pc .skill.s3 { position: relative; right: auto; bottom: auto; }
`;

export default class CombatHud {
  /** @param {{touch: boolean, press: (key: string) => void}} opts */
  constructor({ touch, press }) {
    this.press = press;
    this.mode = null; // 'fight' | 'duel' | null (hidden)
    this.slots = new Map(); // key -> {node, cd, num}
    if (!document.getElementById('combat-style')) {
      const style = document.createElement('style');
      style.id = 'combat-style';
      style.textContent = CSS;
      document.head.append(style);
    }
    this.root = document.createElement('div');
    this.root.id = 'combat';
    this.root.className = touch ? 'touch' : 'pc';
    this.root.hidden = true;
    this.cluster = document.createElement('div');
    this.cluster.className = 'cluster';
    this.caption = document.createElement('div');
    this.caption.className = 'mode';
    this.root.append(this.cluster, this.caption);
    document.body.append(this.root);
  }

  /** Rebuild the buttons for a mode (only when the mode changes). */
  #build(mode) {
    this.cluster.replaceChildren();
    this.slots.clear();
    const skills = mode === 'duel' ? DUEL_SKILLS : FIGHT_SKILLS;
    // the order on a phone: the three skills go around the basic attack, the throw sits further out
    const spots = ['s1', 's2', 's3'];
    let i = 0;
    for (const s of skills) {
      const node = document.createElement('button');
      node.type = 'button';
      node.className = `skill ${s.basic ? 'basic' : s.small ? 'small' : spots[i++]}`;
      node.dataset.key = s.key;
      node.title = s.name;
      node.ariaLabel = s.name;
      const ico = Object.assign(document.createElement('span'), { className: 'ico', textContent: s.icon });
      const cd = Object.assign(document.createElement('span'), { className: 'cd' });
      const num = Object.assign(document.createElement('span'), { className: 'num' });
      const key = Object.assign(document.createElement('span'), { className: 'key', textContent: s.key });
      const label = Object.assign(document.createElement('span'), { className: 'label', textContent: s.name });
      node.append(ico, cd, num, key, label);
      const down = (e) => {
        e.preventDefault();
        node.classList.add('down');
        this.press(s.key);
      };
      const up = () => node.classList.remove('down');
      node.addEventListener('pointerdown', down);
      node.addEventListener('pointerup', up);
      node.addEventListener('pointercancel', up);
      node.addEventListener('pointerleave', up);
      node.addEventListener('contextmenu', (e) => e.preventDefault());
      this.slots.set(s.key, { node, cd, num, skill: s });
      this.cluster.append(node);
    }
    // on a computer the basic attack comes first in the bar, then the skills; the throw is last
    this.mode = mode;
    this.caption.textContent = mode === 'duel' ? 'DUEL' : 'FIGHT MODE   F: back to Friendly';
  }

  /**
   * @param {{mode: 'fight'|'duel'|null, anger: number, cds: Record<string, {until: number, total: number}>, now: number}} s
   *   mode null hides the hud. `cds` are the cooldowns the scene has started, by key.
   */
  update({ mode, anger = 0, cds = {}, now }) {
    const show = mode !== null;
    if (this.root.hidden === show) {
      this.root.hidden = !show;
      document.body.classList.toggle('fighting', show && this.root.classList.contains('touch'));
    }
    if (!show) return;
    if (this.mode !== mode) this.#build(mode);
    for (const [key, slot] of this.slots) {
      let p = 0;
      let text = '';
      if (slot.skill.anger) {
        p = Math.max(0, 1 - anger / 100); // the meter fills up: the sweep shrinks to nothing when it is full
        slot.node.classList.toggle('locked', anger < 100);
        slot.node.classList.toggle('ready', anger >= 100);
        text = anger < 100 ? `${Math.round(anger)}%` : '';
      } else {
        const c = cds[key];
        const left = c ? Math.max(0, c.until - now) : 0;
        p = c && c.total > 0 ? Math.min(1, left / c.total) : 0;
        text = left > 0 ? (left >= 1000 ? Math.ceil(left / 1000) : (left / 1000).toFixed(1)) : '';
      }
      slot.cd.style.setProperty('--p', String(p));
      slot.num.textContent = text;
    }
  }

  destroy() {
    document.body.classList.remove('fighting');
    this.root.remove();
  }
}
