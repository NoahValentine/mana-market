// Search: live Scryfall search with the real syntax, price range and sorting.
import { scryfall, buildQuery, imageOf, printingPrices, ScryfallError } from '../scryfall.js';
import { store } from '../store.js';
import { loadPack } from '../data.js';
import { el, esc, money, moneyExact, deltaHTML, skeletonGrid, emptyState, starButton, toast, basisToggle } from '../ui.js';

const ORDERS = [
  ['usd|desc', 'Price: high → low'], ['usd|asc', 'Price: low → high'],
  ['edhrec|asc', 'Most played (EDHREC)'], ['released|desc', 'Newest printing'],
  ['released|asc', 'Oldest printing'], ['name|asc', 'Name A → Z'],
  ['rarity|desc', 'Rarity'], ['set|asc', 'Set'], ['eur|desc', 'Cardmarket € high → low'],
];
const QUICK = [
  ['is:reserved', 'Reserved List'],
  ['r:mythic', 'Mythic'],
  ['is:foil -is:nonfoil', 'Foil only'],
  ['f:commander', 'Commander legal'],
  ['is:promo', 'Promos'],
  ['t:land', 'Lands'],
  ['border:borderless', 'Borderless'],
  ['is:fullart', 'Full art'],
  ['year<=1995', 'Pre-1996'],
  ['not:reprint', 'First printings'],
];

const state = { text: '', min: null, max: null, order: 'usd|desc', unique: 'cards', extras: false, parts: [] };
const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));

export async function searchView(root, params) {
  if (params.has('q')) state.text = params.get('q');
  if (params.has('min')) state.min = num(params.get('min'));
  if (params.has('max')) state.max = num(params.get('max'));

  root.append(el(`<div class="page-head"><h1>Search</h1><p>Full Scryfall syntax, with prices as the sort key.</p></div>`));

  const form = el('<div class="filters"></div>');
  const qbox = el(`<div class="row" style="gap:8px">
      <input type="text" data-q placeholder="e.g. t:dragon usd>=50" spellcheck="false" style="flex:1;min-width:180px">
      <button class="btn btn-primary" type="button" data-go>Search</button>
    </div>`);
  const qi = qbox.querySelector('[data-q]');
  qi.value = state.text;
  form.append(qbox);

  const quick = el('<div class="bar" aria-label="Quick filters"></div>');
  QUICK.forEach(([token, label]) => {
    const b = el(`<button type="button" class="chip ${state.parts.includes(token) ? 'on' : ''}">${esc(label)}</button>`);
    b.addEventListener('click', () => {
      const i = state.parts.indexOf(token);
      if (i >= 0) state.parts.splice(i, 1); else state.parts.push(token);
      b.classList.toggle('on', state.parts.includes(token));
      run(true);
    });
    quick.append(b);
  });
  form.append(quick);

  const line = el(`<div class="row spread">
      <div class="range">
        <label class="sr-only" for="s-min">Minimum price</label>
        <input id="s-min" type="number" inputmode="decimal" min="0" step="0.5" placeholder="Min $">
        <span class="fine">to</span>
        <label class="sr-only" for="s-max">Maximum price</label>
        <input id="s-max" type="number" inputmode="decimal" min="0" step="0.5" placeholder="Max $">
      </div>
    </div>`);
  const [minI, maxI] = line.querySelectorAll('input');
  minI.value = state.min ?? ''; maxI.value = state.max ?? '';
  const orderSel = el(`<select aria-label="Sort">${ORDERS.map(([k, l]) => `<option value="${k}" ${state.order === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`);
  const uniqueSel = el(`<select aria-label="Printings">
      <option value="cards" ${state.unique === 'cards' ? 'selected' : ''}>One row per card</option>
      <option value="prints" ${state.unique === 'prints' ? 'selected' : ''}>Every printing</option>
      <option value="art" ${state.unique === 'art' ? 'selected' : ''}>Every artwork</option>
    </select>`);
  line.append(orderSel, uniqueSel);
  form.append(line);

  const extrasRow = el('<div class="row"></div>');
  extrasRow.append(basisToggle(() => run(true)));
  const extrasBtn = el(`<button type="button" class="chip ${state.extras ? 'on' : ''}">Include tokens, digital &amp; oddities</button>`);
  extrasBtn.addEventListener('click', () => { state.extras = !state.extras; extrasBtn.classList.toggle('on', state.extras); run(true); });
  extrasRow.append(extrasBtn);
  form.append(extrasRow);

  const built = el('<div class="notice" style="font-family:ui-monospace,Menlo,monospace"></div>');
  form.append(built);
  root.append(form);

  const meta = el('<p class="fine" data-meta></p>');
  root.append(meta);
  const grid = el('<div class="grid"></div>');
  root.append(grid);
  const more = el('<div class="loadmore" hidden><button class="btn" type="button">Load more results</button></div>');
  root.append(more);

  let nextPage = null;
  let pack = null;
  loadPack().then((p) => { pack = p; }).catch(() => {});

  const readInputs = () => {
    state.text = qi.value;
    state.min = num(minI.value);
    state.max = num(maxI.value);
    state.order = orderSel.value;
    state.unique = uniqueSel.value;
  };

  async function run(reset = true) {
    readInputs();
    const [order, dir] = state.order.split('|');
    const q = buildQuery({ ...state, basis: store.basis });
    built.textContent = q;
    if (reset) {
      grid.replaceChildren(skeletonGrid(8));
      nextPage = null;
      history.replaceState(null, '', `#/search?q=${encodeURIComponent(state.text)}`);
    }
    try {
      const res = nextPage ? await scryfall.page(nextPage) : await scryfall.search({
        q, order, dir, unique: state.unique, extras: state.extras,
      });
      if (reset) grid.replaceChildren();
      meta.textContent = `${res.total_cards.toLocaleString()} cards · showing ${Math.min(res.total_cards, grid.children.length + res.data.length).toLocaleString()}`;
      const frag = document.createDocumentFragment();
      res.data.forEach((card) => frag.append(sfTile(card, pack)));
      grid.append(frag);
      nextPage = res.has_more ? res.next_page : null;
      more.hidden = !nextPage;
    } catch (err) {
      grid.replaceChildren();
      more.hidden = true;
      if (err instanceof ScryfallError && err.status === 404) {
        meta.textContent = '';
        grid.append(emptyState('No cards matched', 'Scryfall found nothing for that query. Try removing a filter.'));
      } else {
        meta.textContent = '';
        grid.append(emptyState('Search failed', err.message));
      }
    }
  }

  qbox.querySelector('[data-go]').addEventListener('click', () => run(true));
  qi.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(true); });
  [minI, maxI].forEach((i) => i.addEventListener('change', () => run(true)));
  [orderSel, uniqueSel].forEach((s) => s.addEventListener('change', () => run(true)));
  more.querySelector('button').addEventListener('click', () => run(false));
  store.onChange(() => { /* basis change only affects prefer: on next search */ });

  run(true);
}

/** Tile for a live Scryfall card object. */
export function sfTile(card, pack) {
  const prices = printingPrices(card);
  const cheapest = prices[0];
  const src = imageOf(card, 'normal');
  const packCard = pack?.byOid.get(card.oracle_id);
  const node = el(`
    <a class="tile" href="#/card/${encodeURIComponent(card.id)}">
      <div class="tile-img">
        ${src ? `<img src="${esc(src)}" alt="${esc(card.name)}" loading="lazy" decoding="async" width="488" height="680">`
    : `<div class="empty fine" style="padding:20px 8px">${esc(card.name)}</div>`}
      </div>
      <div class="tile-meta">
        <div class="tile-name">${esc(card.name)}</div>
        <div class="tile-sub">${esc(card.set.toUpperCase())} · ${esc(card.rarity)}${card.lang !== 'en' ? ` · ${esc(card.lang)}` : ''}</div>
        <div class="tile-price">
          <b class="mono">${cheapest ? moneyExact(cheapest.cents) : 'no price'}</b>
          ${packCard ? deltaHTML(packCard.d7) : ''}
        </div>
        <div class="tile-alt mono">${prices.length > 1 ? prices.map((p) => `${p.finish === 'nonfoil' ? '' : `${p.finish} `}${money(p.cents, { compact: true })}`).join(' · ') : (cheapest ? cheapest.finish : '')}</div>
      </div>
    </a>`);
  if (packCard) node.querySelector('.tile-img').append(starButton(packCard, packCard.lo));
  else {
    const b = el('<button type="button" class="tile-star" aria-label="Add to watchlist">☆</button>');
    b.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      store.toggleWatch(card.oracle_id, card.name, cheapest?.cents ?? null);
      toast(`${card.name} added to watchlist`);
      b.classList.add('on');
    });
    node.querySelector('.tile-img').append(b);
  }
  return node;
}
