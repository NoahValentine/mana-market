// Router + shell wiring.
import { store } from './store.js';
import { loadPack } from './data.js';
import { el, toast } from './ui.js';
import { registerSW } from './alerts.js';

const main = document.getElementById('main');

const ROUTES = [
  { re: /^\/?$/, tab: 'market', load: () => import('./views/market.js').then((m) => m.marketView) },
  { re: /^\/trends$/, tab: 'trends', load: () => import('./views/trends.js').then((m) => m.trendsView) },
  { re: /^\/search$/, tab: 'search', load: () => import('./views/search.js').then((m) => m.searchView) },
  { re: /^\/watchlist$/, tab: 'watchlist', load: () => import('./views/watchlist.js').then((m) => m.watchlistView) },
  { re: /^\/deck$/, tab: 'deck', load: () => import('./views/deck.js').then((m) => m.deckView) },
  { re: /^\/card\/(.+)$/, tab: null, load: () => import('./views/card.js').then((m) => m.cardView) },
];

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = raw.split('?');
  return { path: decodeURI(path), params: new URLSearchParams(query) };
}

let current = null;
async function route() {
  const { path, params } = parseHash();
  const key = location.hash || '#/';
  if (key === current) return;
  current = key;

  const match = ROUTES.map((r) => ({ r, m: path.match(r.re) })).find((x) => x.m);
  const arg = match?.m?.[1] ? decodeURIComponent(match.m[1]) : null;

  document.querySelectorAll('[data-tab]').forEach((a) => {
    if (match?.r.tab && a.dataset.tab === match.r.tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  document.title = 'Mana Market — Magic card prices';

  main.replaceChildren();
  window.scrollTo({ top: 0 });
  if (!match) {
    main.append(el('<div class="empty"><h2>Page not found</h2><p><a href="#/">Back to the market</a></p></div>'));
    return;
  }
  try {
    const view = await match.r.load();
    await view(main, params, arg);
  } catch (err) {
    console.error(err);
    main.replaceChildren(el(`<div class="empty"><h2>Something broke</h2><p>${String(err.message || err)}</p></div>`));
  }
  main.focus({ preventScroll: true });
}

// --- shell controls ---------------------------------------------------------
document.querySelectorAll('[data-basis]').forEach((b) => {
  b.classList.toggle('on', b.dataset.basis === store.basis);
  b.addEventListener('click', () => {
    store.setBasis(b.dataset.basis);
    document.querySelectorAll('[data-basis]').forEach((x) => x.classList.toggle('on', x.dataset.basis === store.basis));
  });
});

document.querySelector('[data-theme-toggle]')?.addEventListener('click', () => {
  store.setTheme(store.theme === 'dark' ? 'light' : 'dark');
});

document.querySelector('[data-quicksearch]')?.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = e.target.querySelector('input').value.trim();
  location.hash = `#/search?q=${encodeURIComponent(q)}`;
  if (parseHash().path === '/search') { current = null; route(); }
});

window.addEventListener('hashchange', route);
route();

// --- data stamp + "what moved since your last visit" ------------------------
loadPack().then((pack) => {
  const stamp = document.querySelector('[data-datastamp]');
  if (stamp) {
    stamp.textContent = `Price snapshot ${pack.meta.days[pack.meta.days.length - 1]} · ${pack.cards.length.toLocaleString()} cards tracked · history ${pack.meta.days[0]} → ${pack.meta.days[pack.meta.days.length - 1]}`;
  }
  const today = pack.meta.days[pack.meta.days.length - 1];
  const last = store.get().lastSeenDay;
  if (last && last !== today) {
    const moved = store.watchList()
      .map((w) => pack.byOid.get(w.oid))
      .filter((c) => c && c.d1 != null && Math.abs(c.d1) >= 500);
    if (moved.length) {
      toast(`${moved.length} watchlist card${moved.length === 1 ? '' : 's'} moved more than 5% — see Watchlist`);
    }
  }
  store.set({ lastSeenDay: today });
}).catch((err) => {
  console.error('pack load failed', err);
  const stamp = document.querySelector('[data-datastamp]');
  if (stamp) stamp.textContent = 'Market pack could not be loaded — search still works.';
});

registerSW();
