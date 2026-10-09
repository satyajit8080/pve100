// @ts-check
/*
 * ticker.js — strict ticker/path validation shared by the options + AI routes.
 * Rejects path traversal ('.', '..'), separators (/ \), whitespace, and anything outside
 * [A-Z0-9.]. Accepts normal US equity symbols including class shares (e.g. BRK.B).
 * Returns the normalized uppercase ticker, or null if invalid.
 */
export function safeTicker(raw) {
  if (raw == null) return null;
  const t = String(raw).trim().toUpperCase();
  if (!t) return null;
  if (!/^[A-Z0-9.]{1,10}$/.test(t)) return null;        // only letters/digits/dot, bounded length; blocks / \ space etc.
  if (t.includes('..')) return null;                    // path traversal
  if (t.startsWith('.') || t.endsWith('.')) return null; // no leading/trailing dot
  if (!/[A-Z]/.test(t)) return null;                    // must contain a letter (blocks '123', '.', '..')
  return t;
}
