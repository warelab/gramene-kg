// CURIE input with autocompletion (ARIA combobox + listbox): /resolve for exact ids and aliases, /search for
// text, plus `extra(q)` (e.g. the workspace's curated nodes, which need not exist in the build).
import { api } from './api.js';
import { h, fill } from './lib.js';
import { badge } from './ui.js';

let seq = 0;
// -> { el, input, value (getter), set(v) }; onPick(item) after a choice
export function curiePicker({ label, name, required = false, value = '', extra = () => [], onPick } = {}) {
  const id = `pk${++seq}`;
  const input = h('input', { id, name, type: 'text', required, value, spellcheck: 'false', autocomplete: 'off', role: 'combobox',
    'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': `${id}-list`, 'aria-describedby': `${id}-st`, class: 'curie' });
  const list = h('ul', { id: `${id}-list`, role: 'listbox', class: 'suggest', hidden: true, 'aria-label': `${label} suggestions` });
  const status = h('div', { id: `${id}-st`, class: 'small muted pick-status', 'aria-live': 'polite' });
  let items = [], active = -1, timer = null, ctrl = null;

  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1; };
  const highlight = (i) => {
    active = i;
    [...list.children].forEach((li, j) => li.setAttribute('aria-selected', j === i ? 'true' : 'false'));
    if (i >= 0) { input.setAttribute('aria-activedescendant', `${id}-o${i}`); list.children[i]?.scrollIntoView?.({ block: 'nearest' }); }
  };
  const pick = (it) => {
    input.value = it.id; close();
    fill(status, '✓ ', it.name && it.name !== it.id ? `${it.name} ` : '', badge(it.class), it.origin === 'curated' ? badge('curated node', 'cur') : null);
    onPick?.(it);
  };
  const render = () => {
    fill(list, ...items.map((it, i) => h('li', { id: `${id}-o${i}`, role: 'option', 'aria-selected': 'false',
      onmousedown: (ev) => { ev.preventDefault(); pick(it); } },
      h('span', { class: 'opt-name' }, it.name || it.id), ' ', h('code', { class: 'small' }, it.id), ' ', badge(it.class),
      it.origin === 'curated' ? badge('curated node', 'cur') : null, it.genome ? h('span', { class: 'muted small' }, ` ${it.genome}`) : null)));
    list.hidden = !items.length; input.setAttribute('aria-expanded', String(!!items.length)); active = -1;
  };

  async function query(q) {
    ctrl?.abort(); ctrl = new AbortController();
    const { signal } = ctrl;
    const exact = /\s/.test(q) ? Promise.resolve(null) : api('resolve', { ids: q }, { signal }).catch(() => null);
    const text = api('search', { q, rows: 8 }, { signal }).catch(() => null);
    const [r, s] = await Promise.all([exact, text]);
    if (signal.aborted) return;
    const out = [], seen = new Set();
    const add = (x, origin) => { if (x?.id && !seen.has(x.id)) { seen.add(x.id); out.push({ id: x.id, name: x.name ?? null, class: x.class ?? x.cls ?? null, genome: x.genome ?? null, origin }); } };
    for (const x of r?.data?.resolved ?? []) add(x, 'resolve');
    for (const a of r?.data?.ambiguous ?? []) for (const x of a.candidates ?? []) add(x, 'resolve');
    const ql = q.toLowerCase();
    for (const x of extra() ?? []) if (String(x.id).toLowerCase().includes(ql) || String(x.name ?? '').toLowerCase().includes(ql)) add(x, 'curated');
    for (const x of s?.data ?? []) add(x, 'search');
    items = out.slice(0, 12); render();
  }
  // after a free-typed value: say whether it resolves, is ambiguous, or must be a curated node
  async function check() {
    const v = input.value.trim();
    if (!v) { status.textContent = ''; return; }
    if ((extra() ?? []).some(x => x.id === v)) { fill(status, '✓ curated node in this workspace'); return; }
    const r = await api('resolve', { ids: v }).catch(() => null);
    if (input.value.trim() !== v) return;
    const res = r?.data?.resolved?.[0], amb = r?.data?.ambiguous?.[0];
    if (res) {
      if (res.id !== v) fill(status, 'resolves to ', h('code', null, res.id), ' ', badge(res.class), ' ',
        h('button', { type: 'button', class: 'link', onclick: () => pick({ ...res, origin: 'resolve' }) }, 'use it'));
      else fill(status, '✓ ', res.name && res.name !== res.id ? `${res.name} ` : '', badge(res.class));
    } else if (amb) fill(status, `ambiguous: ${amb.candidates?.length ?? 'several'} candidates; pick one from the list`);
    else fill(status, h('span', { class: 'warn' }, 'not in this build: it must be a curated node of this workspace'));
  }

  input.addEventListener('input', () => {
    clearTimeout(timer); status.textContent = '';
    const q = input.value.trim();
    if (q.length < 2) { ctrl?.abort(); items = []; close(); return; }
    timer = setTimeout(() => query(q), 250);
  });
  input.addEventListener('keydown', (ev) => {
    if (list.hidden) { if (ev.key === 'ArrowDown' && items.length) { list.hidden = false; input.setAttribute('aria-expanded', 'true'); highlight(0); ev.preventDefault(); } return; }
    if (ev.key === 'ArrowDown') { highlight(Math.min(items.length - 1, active + 1)); ev.preventDefault(); }
    else if (ev.key === 'ArrowUp') { highlight(Math.max(0, active - 1)); ev.preventDefault(); }
    else if (ev.key === 'Enter' && active >= 0) { pick(items[active]); ev.preventDefault(); }
    else if (ev.key === 'Escape') { close(); ev.preventDefault(); }
  });
  input.addEventListener('blur', () => { close(); setTimeout(check, 0); });

  const el = h('div', { class: 'picker' }, h('label', { for: id }, label, required ? ' *' : ''), h('div', { class: 'pick-wrap' }, input, list), status);
  return { el, input, get value() { return input.value.trim(); }, set(v) { input.value = v ?? ''; status.textContent = ''; } };
}
