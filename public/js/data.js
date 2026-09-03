// The static market pack: cards.json + meta.json + trends.json, plus lazy
// per-card price history read out of series.bin with a byte-range request.
// See SPEC.md for the field contract.

// Relative to the page, so the app works at a domain root AND under a GitHub
// Pages sub-path like /mana-market/.
const BASE = new URL('data/', document.baseURI).href;

let packPromise = null;
export function loadPack() {
  if (!packPromise) packPromise = build();
  return packPromise;
}

async function getJSON(path) {
  const res = await fetch(BASE + path, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

const FINISH = ['nonfoil', 'foil', 'etched'];
const RARITY = ['common', 'uncommon', 'rare', 'mythic', 'special'];
const TYPE_BITS = [
  [1, 'Creature'], [2, 'Instant'], [4, 'Sorcery'], [8, 'Artifact'],
  [16, 'Enchantment'], [32, 'Planeswalker'], [64, 'Land'], [128, 'Battle'], [256, 'Legendary'],
];

async function build() {
  const [meta, cards, trends] = await Promise.all([
    getJSON('meta.json'), getJSON('cards.json'), getJSON('trends.json'),
  ]);

  const f = {};
  cards.fields.forEach((name, i) => { f[name] = i; });

  const list = cards.rows.map((r) => ({
    oid: r[f.oid], name: r[f.n],
    lo: r[f.lo], loId: r[f.loId], loF: r[f.loF], loS: r[f.loS],
    hi: r[f.hi], hiId: r[f.hiId], hiF: r[f.hiF], hiS: r[f.hiS],
    np: r[f.np], rarity: r[f.r], cid: r[f.cid] || '', types: r[f.t],
    reserved: Boolean(r[f.res]), year: r[f.yr],
    d1: r[f.d1], d7: r[f.d7], d30: r[f.d30], d90: r[f.d90],
    row: r[f.row], img: r[f.img], cn: r[f.cn], edh: r[f.edh],
  }));

  const byOid = new Map(list.map((c) => [c.oid, c]));
  const byName = new Map(list.map((c) => [c.name.toLowerCase(), c]));
  // Lowercase-name index also keyed on the front face of split/modal cards.
  for (const c of list) {
    const front = c.name.split(' // ')[0].toLowerCase();
    if (!byName.has(front)) byName.set(front, c);
  }

  return { meta, cards: list, byOid, byName, trends };
}

// ---- price history (series.bin) --------------------------------------------
const seriesCache = new Map();

export async function seriesFor(pack, card) {
  if (!card || card.row == null || card.row < 0) return null;
  if (seriesCache.has(card.row)) return seriesCache.get(card.row);

  const { cols, row_bytes: rowBytes } = pack.meta.series;
  const start = card.row * rowBytes;
  const end = start + rowBytes - 1;
  let values = null;
  try {
    const res = await fetch(`${BASE}series.bin`, { headers: { Range: `bytes=${start}-${end}` } });
    if (!res.ok) throw new Error(`series HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    if (res.status === 200 && buf.byteLength > rowBytes) {
      // Server ignored the Range header and sent the whole file.
      values = Array.from(new Int32Array(buf, start, cols));
    } else if (buf.byteLength >= rowBytes) {
      values = Array.from(new Int32Array(buf, 0, cols));
    }
  } catch {
    values = null;
  }
  const out = values ? pack.meta.days.map((day, i) => ({ day, cents: values[i] })).filter((p) => p.cents >= 0) : null;
  seriesCache.set(card.row, out);
  return out;
}

// ---- helpers ---------------------------------------------------------------
export const finishName = (i) => FINISH[i] || 'nonfoil';
export const rarityName = (i) => RARITY[i] || 'common';
export function typeNames(mask) {
  return TYPE_BITS.filter(([bit]) => mask & bit).map(([, n]) => n);
}
export function priceOf(card, basis) { return basis === 'hi' ? card.hi : card.lo; }
export function printingOf(card, basis) {
  return basis === 'hi'
    ? { id: card.hiId, set: card.hiS, finish: card.hiF }
    : { id: card.loId, set: card.loS, finish: card.loF };
}
export function deltaOf(card, window) { return card[window]; }

export function imgUrl(imgKey, size = 'normal') {
  if (!imgKey) return null;
  return `https://cards.scryfall.io/${size}/${imgKey}`;
}
