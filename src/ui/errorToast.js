// A small, unobtrusive "something went wrong" notice. Errors are de-duplicated and rate-limited so a bug that
// fires every frame produces one message (and one console line), not thousands.

const COOLDOWN_MS = 8000;
const seen = new Map(); // message -> count
let lastShown = 0;
let timer = null;

export function reportError(err, { toast = true } = {}) {
  const message = String(err?.message ?? err ?? 'unknown error').slice(0, 160);
  const count = (seen.get(message) ?? 0) + 1;
  seen.set(message, count);
  if (count === 1 || count % 500 === 0) console.error(`[game] ${message}${count > 1 ? ` (x${count})` : ''}`, err?.stack ?? '');
  if (toast && count === 1) show('Something went wrong. The game keeps running; if it feels stuck, reload the page.');
  return count;
}

export function showNotice(text) {
  show(text, true);
}

function show(text, force = false) {
  const now = Date.now();
  if (!force && now - lastShown < COOLDOWN_MS) return;
  lastShown = now;
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  clearTimeout(timer);
  timer = setTimeout(() => (el.hidden = true), 6000);
}

/** Hook the page-level handlers. Safe to call once at start-up. */
export function installGlobalHandlers() {
  window.addEventListener('error', (e) => reportError(e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => reportError(e.reason));
}

export const errorCounts = () => new Map(seen);
