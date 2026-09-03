// Market: the whole tracked universe, filtered and sorted locally (instant).
import { loadPack, typeNames, rarityName } from '../data.js';
import { store } from '../store.js';
import { el, esc, cardTile, money, skeletonGrid, statTile, emptyState, basisToggle, fmtDay } from '../ui.js';

const PRESETS = [
  { k: 'any', label: 'Any price', min: null, max: null },
  { k: 'u5', label: 'Under $5', min: null, max: 5 },
  { k: '5-20', label: '$5–20', min: 5, max: 20 },
  { k: '20-100', label: '$20–100', min: 20, max: 100 },
  { k: '100-500', label: '$100–500', min: 100, max: 500 },
  { k: '500+', label: '$500+', min: 500, max: null },
];
const SORTS = [
  ['price-desc', 'Price: high → low'],
  ['price-asc', 'Price: low → high'],
  ['d1-desc', '24h gain'], ['d1-asc', '24h loss'],
  ['d7-desc', '7d gain'], ['d7-asc', '7d loss'],
  ['d30-desc', '30d gain'], ['d30-asc', '30d loss'],
  ['d90-desc', '90d gain'], ['d90-asc', '90d loss'],
  ['name-asc', 'Name A → Z'],
  ['year-asc', 'Oldest printing'],
  ['edh-asc', 'Most played (EDHREC)'],
];
const COLORS = [['W', 'White'], ['U', 'Blue'], ['B', 'Black'], ['R', 'Red'], ['G', 'Green'], ['C', 'Colorless']];
const RARITIES = [[2, 'Rare'], [3, 'Mythic'], [1, 'Uncommon'], [0, 'Common'], [4, 'Special']];
const TYPES = [[1, 'Creature'], [64, 'Land'], [8, 'Artifact'], [16, 'Enchantment'], [2, 'Instant'], [4, 'Sorcery'], [32, 'Planeswalker'], [256, 'Legendary']];

const PAGE = 60;

const state = {
  preset: 'any', min: null, max: null, sort: 'price-desc',
  colors: new Set(), rarities: new Set(), types: new Set(),
  reserved: false, text: '', shown: PAGE,
};

export function marketQueryFromHash(params) {
  if (params.has('min')) state.min = num(params.get('min'));
  if (params.has('max')) state.max = num(params.get('max'));
  if (params.has('sort')) state.sort = params.get('sort');
  if (params.has('q')) state.text = params.get('q');
  if (state.min != null || state.max != null) state.preset = 'custom';
}
const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));

export async function marketView(root, params) {
  marketQueryFromHash(params);
  root.append(el(`<div class="page-head"><h1>Most expensive cards</h1><p data-count>loading…</p></div>`));
  const filters = renderFilters(() => refresh());
  root.append(filters);
  const summary = el('<div class="summary only-mobile" data-summary></div>');
  root.append(summary);
  const stats = el('<div class="stats not-mobile" style="margin-bottom:14px"></div>');
  root.append(stats);
  const grid = el('<div class="grid"></div>');
  const skel = skeletonGrid(12);
  root.append(skel);

  const pack = await loadPack();
  skel.remove();
  root.append(grid);
  const more = el('<div class="loadmore"><button class="btn" type="button">Show more</button></div>');
  root.append(more);

  // Rebuilding the grid mid-interaction eats taps (a pointerdown followed by a
  // replaced node never becomes a click), and browsers fire `change` on blur —
  // which happens exactly when you tap something else. So a refresh whose inputs
  // did not actually change is a no-op.
  let lastSig = null;
  const signature = () => JSON.stringify([
    state.min, state.max, state.sort, state.reserved, state.text, state.shown,
    [...state.colors].sort(), [...state.rarities].sort(), [...state.types].sort(), store.basis,
  ]);

  const refresh = () => {
    const sig = signature();
    if (sig === lastSig && grid.children.length) return;
    lastSig = sig;
    const basis = store.basis;
    const rows = filterSort(pack.cards, basis);
    const countEl = root.querySelector('[data-count]');
    const day = pack.meta.days[pack.meta.days.length - 1];
    countEl.textContent = `${rows.length.toLocaleString()} of ${pack.cards.length.toLocaleString()} cards`
      + ` · ${basis === 'hi' ? 'priciest' : 'cheapest'} printing`
      + ` · ${fmtDay(day)}`;

    const top = rows[0];
    const topPrice = top ? (basis === 'hi' ? top.hi : top.lo) : null;
    const median = medianOf(rows, basis);
    const total = rows.reduce((a, c) => a + (basis === 'hi' ? c.hi : c.lo), 0);
    const over100 = rows.filter((c) => (basis === 'hi' ? c.hi : c.lo) >= 10000).length;
    stats.replaceChildren(
      statTile('Top card', money(topPrice), esc(top?.name || '—')),
      statTile('Median in view', money(median)),
      statTile('Total in view', money(total, { compact: true })),
      statTile('Above $100', String(over100)),
    );
    summary.innerHTML = top
      ? `<span><b>${esc(top.name)}</b> ${money(topPrice)}</span><span>median ${money(median)}</span>`
        + `<span>${over100} over $100</span><span>${money(total, { compact: true })} total</span>`
      : '';

    grid.replaceChildren();
    if (!rows.length) {
      grid.append(emptyState('Nothing matches', 'Widen the price range or clear a filter.'));
      more.hidden = true;
      return;
    }
    const win = state.sort.startsWith('d') ? state.sort.split('-')[0] : 'd7';
    const slice = rows.slice(0, state.shown);
    const frag = document.createDocumentFragment();
    slice.forEach((c, i) => frag.append(cardTile(c, {
      basis, window: win, rank: state.sort === 'price-desc' ? i + 1 : null,
    })));
    grid.append(frag);
    more.hidden = rows.length <= state.shown;
    more.querySelector('button').textContent = `Show more (${(rows.length - state.shown).toLocaleString()} left)`;
  };

  more.querySelector('button').addEventListener('click', () => { state.shown += PAGE * 2; refresh(); });
  // Only re-render for things that change what the grid shows. Starring a card
  // must NOT rebuild the grid: it would rip the button out from under the tap.
  let lastBasis = store.basis;
  store.onChange((s) => {
    if (s.basis !== lastBasis) { lastBasis = s.basis; refresh(); }
  });
  refresh();
}

function medianOf(rows, basis) {
  if (!rows.length) return null;
  const v = rows.map((c) => (basis === 'hi' ? c.hi : c.lo)).sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
}

function filterSort(cards, basis) {
  const price = (c) => (basis === 'hi' ? c.hi : c.lo);
  const minC = state.min != null ? state.min * 100 : null;
  const maxC = state.max != null ? state.max * 100 : null;
  const text = state.text.trim().toLowerCase();

  let rows = cards.filter((c) => {
    const p = price(c);
    if (minC != null && p < minC) return false;
    if (maxC != null && p > maxC) return false;
    if (state.reserved && !c.reserved) return false;
    if (state.rarities.size && !state.rarities.has(c.rarity)) return false;
    if (state.types.size && ![...state.types].some((bit) => c.types & bit)) return false;
    if (state.colors.size) {
      const wantC = state.colors.has('C');
      const letters = [...state.colors].filter((x) => x !== 'C');
      const isColorless = !c.cid;
      const ok = (wantC && isColorless) || letters.some((L) => c.cid.includes(L));
      if (!ok) return false;
    }
    if (text && !c.name.toLowerCase().includes(text) && !c.loS.toLowerCase().includes(text) && !c.hiS.toLowerCase().includes(text)) return false;
    return true;
  });

  const [key, dir] = state.sort.split('-');
  const sign = dir === 'asc' ? 1 : -1;
  const cmp = {
    price: (a, b) => (price(a) - price(b)) * sign,
    name: (a, b) => a.name.localeCompare(b.name) * (dir === 'asc' ? 1 : -1),
    year: (a, b) => (a.year - b.year) * sign,
    edh: (a, b) => ((a.edh || 1e9) - (b.edh || 1e9)) * sign,
  }[key] || ((a, b) => {
    const av = a[key]; const bv = b[key];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;          // unknown history always sinks
    if (bv == null) return -1;
    return (av - bv) * sign;
  });
  rows = rows.slice().sort(cmp);
  return rows;
}

function renderFilters(onChange) {
  const box = el('<div class="filters"></div>');

  // price presets
  const bar = el('<div class="bar" role="group" aria-label="Price range"></div>');
  PRESETS.forEach((p) => {
    const b = el(`<button type="button" class="chip ${state.preset === p.k ? 'on' : ''}" data-preset="${p.k}">${p.label}</button>`);
    b.addEventListener('click', () => {
      state.preset = p.k; state.min = p.min; state.max = p.max; state.shown = PAGE;
      bar.querySelectorAll('[data-preset]').forEach((x) => x.classList.toggle('on', x.dataset.preset === p.k));
      minI.value = p.min ?? ''; maxI.value = p.max ?? '';
      syncHash(); onChange();
    });
    bar.append(b);
  });
  box.append(bar);

  // custom range + sort
  const line = el('<div class="row spread"></div>');
  line.append(basisToggle(onChange));
  const range = el(`<div class="range">
      <label class="sr-only" for="mm-min">Minimum price in dollars</label>
      <input id="mm-min" type="number" inputmode="decimal" min="0" step="0.5" placeholder="Min $">
      <span class="fine">to</span>
      <label class="sr-only" for="mm-max">Maximum price in dollars</label>
      <input id="mm-max" type="number" inputmode="decimal" min="0" step="0.5" placeholder="Max $">
    </div>`);
  const [minI, maxI] = range.querySelectorAll('input');
  minI.value = state.min ?? ''; maxI.value = state.max ?? '';
  let applyTimer = null;
  const apply = () => {
    clearTimeout(applyTimer);          // a queued keystroke must not re-render later
    applyTimer = null;
    state.min = num(minI.value); state.max = num(maxI.value); state.preset = 'custom'; state.shown = PAGE;
    bar.querySelectorAll('[data-preset]').forEach((x) => x.classList.remove('on'));
    syncHash(); onChange();
  };
  // React to typing as well as blur: on a phone people rarely dismiss the
  // keyboard before looking at the results.
  const applySoon = () => { clearTimeout(applyTimer); applyTimer = setTimeout(apply, 250); };
  [minI, maxI].forEach((i) => {
    i.addEventListener('change', apply);
    i.addEventListener('input', applySoon);
  });

  const sortSel = el(`<select aria-label="Sort">${SORTS.map(([k, l]) => `<option value="${k}" ${state.sort === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`);
  sortSel.addEventListener('change', () => { state.sort = sortSel.value; state.shown = PAGE; syncHash(); onChange(); });

  line.append(range, sortSel);
  box.append(line);

  // more filters
  const det = el(`<details class="more"><summary>Filters${filterCount() ? ` · ${filterCount()} on` : ''}</summary><div></div></details>`);
  const inner = det.querySelector('div');

  inner.append(groupBar('Colors', COLORS.map(([k, l]) => ({ k, l })), state.colors, onChange));
  inner.append(groupBar('Rarity', RARITIES.map(([k, l]) => ({ k, l })), state.rarities, onChange));
  inner.append(groupBar('Type', TYPES.map(([k, l]) => ({ k, l })), state.types, onChange));

  const extra = el('<div class="row"></div>');
  const res = el(`<button type="button" class="chip ${state.reserved ? 'on' : ''}">Reserved List only</button>`);
  res.addEventListener('click', () => { state.reserved = !state.reserved; res.classList.toggle('on', state.reserved); state.shown = PAGE; onChange(); });
  const nameI = el('<input type="text" placeholder="Name or set contains…" style="flex:1;min-width:160px">');
  nameI.value = state.text;
  nameI.addEventListener('input', () => { state.text = nameI.value; state.shown = PAGE; onChange(); });
  const clear = el('<button type="button" class="btn btn-ghost">Reset</button>');
  clear.addEventListener('click', () => {
    state.colors.clear(); state.rarities.clear(); state.types.clear();
    state.reserved = false; state.text = ''; state.min = null; state.max = null;
    state.preset = 'any'; state.shown = PAGE;
    box.replaceWith(renderFilters(onChange));
    syncHash(); onChange();
  });
  extra.append(res, nameI, clear);
  inner.append(extra);
  box.append(det);
  return box;
}

function filterCount() {
  return state.colors.size + state.rarities.size + state.types.size + (state.reserved ? 1 : 0) + (state.text ? 1 : 0);
}

function groupBar(label, items, set, onChange) {
  const wrap = el(`<div><div class="fine" style="margin-bottom:5px">${esc(label)}</div><div class="bar"></div></div>`);
  const bar = wrap.querySelector('.bar');
  items.forEach(({ k, l }) => {
    const b = el(`<button type="button" class="chip ${set.has(k) ? 'on' : ''}">${esc(l)}</button>`);
    b.addEventListener('click', () => {
      if (set.has(k)) set.delete(k); else set.add(k);
      b.classList.toggle('on', set.has(k));
      state.shown = PAGE;
      onChange();
    });
    bar.append(b);
  });
  return wrap;
}

let hashGuard = false;
function syncHash() {
  const p = new URLSearchParams();
  if (state.min != null) p.set('min', state.min);
  if (state.max != null) p.set('max', state.max);
  if (state.sort !== 'price-desc') p.set('sort', state.sort);
  hashGuard = true;
  const q = p.toString();
  history.replaceState(null, '', `#/${q ? `?${q}` : ''}`);
  hashGuard = false;
}
export const isSelfHashChange = () => hashGuard;
export { rarityName, typeNames };
