// Throttled, cached Scryfall client.
// Scryfall asks for <= 10 req/s overall and is stricter on the expensive
// endpoints; prices only change once a day, so responses are cached for 24h.

const API = 'https://api.scryfall.com';
const SLOW = /^\/cards\/(search|named|random|collection)/;   // 500ms apart
const DAY = 24 * 60 * 60 * 1000;

let chain = Promise.resolve();
let lastSlow = 0;
let lastAny = 0;

const mem = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cacheGet(key) {
  if (mem.has(key)) return mem.get(key);
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const { t, v } = JSON.parse(raw);
    if (Date.now() - t > DAY) { sessionStorage.removeItem(key); return null; }
    mem.set(key, v);
    return v;
  } catch { return null; }
}

function cacheSet(key, value) {
  mem.set(key, value);
  try { sessionStorage.setItem(key, JSON.stringify({ t: Date.now(), v: value })); }
  catch { /* quota — memory cache still holds it */ }
}

export class ScryfallError extends Error {
  constructor(status, body) {
    super(body?.details || `Scryfall returned HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function request(path, opts = {}) {
  const key = `sf:${path}${opts.body ? `:${opts.body}` : ''}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const run = async () => {
    const slow = SLOW.test(path);
    const gap = slow ? 550 : 120;
    const since = Date.now() - (slow ? lastSlow : lastAny);
    if (since < gap) await sleep(gap - since);

    const res = await fetch(API + path, {
      method: opts.method || 'GET',
      headers: { Accept: 'application/json', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
      body: opts.body,
    });
    lastAny = Date.now();
    if (slow) lastSlow = lastAny;

    if (res.status === 429) {
      await sleep(2500);
      throw new ScryfallError(429, { details: 'Rate limited by Scryfall — try again in a moment.' });
    }
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    if (!res.ok) throw new ScryfallError(res.status, json);
    cacheSet(key, json);
    return json;
  };

  // Serialise every request so the throttle actually holds.
  const result = chain.then(run, run);
  chain = result.catch(() => {});
  return result;
}

// ---- endpoints -------------------------------------------------------------
export const scryfall = {
  search({ q, order = 'usd', dir = 'desc', unique = 'cards', extras = false, page = 1 }) {
    const p = new URLSearchParams({ q, order, dir, unique, page: String(page) });
    if (extras) { p.set('include_extras', 'true'); p.set('include_variations', 'true'); }
    return request(`/cards/search?${p}`);
  },
  page(url) { return request(url.replace(API, '')); },
  card(id) { return request(`/cards/${encodeURIComponent(id)}`); },
  named(name) { return request(`/cards/named?exact=${encodeURIComponent(name)}`); },
  autocomplete(q) { return request(`/cards/autocomplete?q=${encodeURIComponent(q)}`); },
  rulings(id) { return request(`/cards/${encodeURIComponent(id)}/rulings`); },
  printings(oracleId) {
    const p = new URLSearchParams({
      q: `oracleid:${oracleId} game:paper`, unique: 'prints', order: 'usd', dir: 'asc',
      include_variations: 'true', include_extras: 'true',
    });
    return request(`/cards/search?${p}`);
  },
  collection(identifiers) {
    return request('/cards/collection', { method: 'POST', body: JSON.stringify({ identifiers }) });
  },
};

// ---- query building --------------------------------------------------------
export function buildQuery({ text = '', min = null, max = null, basis = 'lo', unique = 'cards', extras = false, parts = [] }) {
  const q = [];
  const raw = text.trim();
  if (raw) q.push(raw);
  q.push(...parts.filter(Boolean));
  if (!/\bgame:/.test(raw)) q.push('game:paper');
  if (!extras && !/is:digital/.test(raw)) q.push('-is:digital');
  if (min != null && !/usd>/.test(raw)) q.push(`usd>=${min}`);
  if (max != null && !/usd</.test(raw)) q.push(`usd<=${max}`);
  if (unique === 'cards' && !/prefer:/.test(raw)) q.push(basis === 'hi' ? 'prefer:usd-high' : 'prefer:usd-low');
  if (!raw && !parts.length && min == null && max == null) q.push('usd>=0.01');   // a query is required
  return q.join(' ');
}

// ---- card helpers ----------------------------------------------------------
export function faceOf(card, faceIndex = 0) {
  if (card.card_faces && card.card_faces.length && !card.image_uris) {
    return card.card_faces[Math.min(faceIndex, card.card_faces.length - 1)];
  }
  if (card.card_faces && card.card_faces.length) {
    return { ...card, ...card.card_faces[Math.min(faceIndex, card.card_faces.length - 1)] };
  }
  return card;
}

export function imageOf(card, size = 'normal', faceIndex = 0) {
  const face = faceOf(card, faceIndex);
  const uris = face.image_uris || card.image_uris;
  if (!uris) return null;
  return uris[size] || uris.normal || null;
}

export function hasBack(card) {
  return Boolean(card.card_faces && card.card_faces.length > 1 && !card.image_uris);
}

/** Cheapest / dearest priced finish on a single printing. cents + finish. */
export function printingPrices(card) {
  const out = [];
  const add = (finish, v) => { if (v != null) out.push({ finish, cents: Math.round(parseFloat(v) * 100) }); };
  add('nonfoil', card.prices?.usd);
  add('foil', card.prices?.usd_foil);
  add('etched', card.prices?.usd_etched);
  return out.sort((a, b) => a.cents - b.cents);
}
