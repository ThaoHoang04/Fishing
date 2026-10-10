/** Rules for chat text, shared by the server (which enforces them) and the client (which shows the limit). */
export const CHAT_MAX = 100; // characters
export const CHAT_GAP_MS = 700; // minimum time between two messages from one player
export const CHAT_BURST = 6; // at most this many messages...
export const CHAT_BURST_MS = 10000; // ...in this window

// Control characters, zero-width and bidi-override characters: replaced by a space so they cannot hide or reorder text.
const INVISIBLE_RANGES = [[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff]];
const isInvisible = (code) => INVISIBLE_RANGES.some(([lo, hi]) => code >= lo && code <= hi);

/** Clean up a message: no control or invisible characters, single spaces, cut to CHAT_MAX characters. Returns '' if nothing is left. */
export function sanitizeChat(text) {
  if (typeof text !== 'string') return '';
  const visible = [...text].map((ch) => (isInvisible(ch.codePointAt(0)) ? ' ' : ch)).join('');
  const clean = visible.replace(/\s+/g, ' ').trim();
  return [...clean].slice(0, CHAT_MAX).join('').trim();
}

/** Flood guard for one player. `times` is that player's own array of recent send times; returns true and records the send if allowed. */
export function allowChat(times, now) {
  while (times.length && now - times[0] > CHAT_BURST_MS) times.shift();
  if (times.length && now - times[times.length - 1] < CHAT_GAP_MS) return false;
  if (times.length >= CHAT_BURST) return false;
  times.push(now);
  return true;
}
