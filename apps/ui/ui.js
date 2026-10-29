// Shared view helpers used by the page modules.
import { ApiError } from './api.js';
import { h } from './lib.js';

export function announce(msg) { const s = document.getElementById('status'); if (s) s.textContent = msg; }
export function setTitle(t) { document.title = t ? `${t} · Gramene KG` : 'Gramene KG'; }

// error panel for a failed API call (404 / 400 / 5xx / network); `extra` is appended inside it
export function errorBox(err, extra) {
  if (err?.name === 'AbortError') return null;
  const st = err instanceof ApiError ? err.status : null;
  return h('div', { class: 'error', role: 'alert' },
    h('strong', null, st === 404 ? 'Not found' : st ? `Error ${st}` : 'Error'), ': ', err?.message ?? String(err),
    err?.hint ? h('div', { class: 'hint' }, err.hint) : null, extra ?? null);
}

export const badge = (text, cls = '') => (text ? h('span', { class: `badge ${cls}`.trim() }, text) : null);
export const section = (title, ...kids) => h('section', { class: 'panel' }, h('h2', null, title), ...kids);
