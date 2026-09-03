// scripts/lib/scryfall.mjs
//
// Shared helpers for turning a Scryfall "default_cards" bulk-data file
// into a Mana Market snapshot: per-oracle-id cheapest/most-expensive paper
// printing + finish, plus the derived fields cards.json needs (rarity,
// color identity, type bitmask, reserved flag, oldest printing year, image
// key, edhrec rank, collector number).
//
// Streaming: the bulk file is 500MB+ uncompressed and Scryfall serves it as
// gzipped JSON Lines these days (it used to be one big JSON array, and both
// shapes are still handled — see detectJsonShape). We never hold the whole
// file in memory: records are streamed one at a time and only small
// per-oracle-id aggregates are kept (~30k oracle ids, a few hundred bytes
// each -> a few MB total).
//
// The "unless it is the only printing of that card" language exception
// requires knowing, for every oracle_id, whether *any* otherwise-eligible
// printing is in English. That can only be known after seeing every
// printing, so this module streams the source file TWICE: pass 1 builds
// the has-English-printing set, pass 2 does the actual aggregation. For a
// remote URL we first download once to a local temp file and stream that
// file twice, so we never pay bandwidth twice and never buffer the JSON
// in memory.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { pipeline as streamPipeline } from 'node:stream/promises';
import streamJsonPkg from 'stream-json';
import streamArrayPkg from 'stream-json/streamers/StreamArray.js';
import pickPkg from 'stream-json/filters/Pick.js';
import streamObjectPkg from 'stream-json/streamers/StreamObject.js';

const { parser } = streamJsonPkg;
const { streamArray } = streamArrayPkg;
const { pick } = pickPkg;
const { streamObject } = streamObjectPkg;

// ---------------------------------------------------------------------------
// Universe exclusion rules (SPEC "Universe")
// ---------------------------------------------------------------------------

const EXCLUDED_SET_TYPES = new Set(['memorabilia', 'token', 'minigame', 'alchemy']);
const EXCLUDED_LAYOUTS = new Set([
  'token',
  'double_faced_token',
  'emblem',
  'art_series',
  'vanguard',
  'scheme',
  'planar',
]);

/**
 * Card-shape filters that do NOT depend on language: digital, oversized,
 * excluded set types/layouts, and "not actually available in paper".
 * The English-only-unless-sole-printing rule is layered on top of this in
 * the two-pass aggregation below, since it needs cross-printing knowledge.
 */
export function passesTypeFilter(card) {
  if (card.digital === true) return false;
  if (card.oversized === true) return false;
  if (card.set_type && EXCLUDED_SET_TYPES.has(card.set_type)) return false;
  if (card.layout && EXCLUDED_LAYOUTS.has(card.layout)) return false;
  if (Array.isArray(card.games) && card.games.length > 0 && !card.games.includes('paper')) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Price extraction
// ---------------------------------------------------------------------------

export const FINISH = { NONFOIL: 0, FOIL: 1, ETCHED: 2 };
export const FINISH_KEYS = ['usd', 'usd_foil', 'usd_etched'];

/** Dollars-as-string -> integer cents, or null if absent/unparseable. */
export function usdToCents(usdStr) {
  if (usdStr === null || usdStr === undefined) return null;
  const f = parseFloat(usdStr);
  if (!Number.isFinite(f)) return null;
  return Math.round(f * 100);
}

/** All usable {finish, cents} price points on one printing. */
export function printingPricePoints(card) {
  const prices = card.prices || {};
  const out = [];
  const nonfoil = usdToCents(prices.usd);
  if (nonfoil !== null) out.push({ finish: FINISH.NONFOIL, cents: nonfoil });
  const foil = usdToCents(prices.usd_foil);
  if (foil !== null) out.push({ finish: FINISH.FOIL, cents: foil });
  const etched = usdToCents(prices.usd_etched);
  if (etched !== null) out.push({ finish: FINISH.ETCHED, cents: etched });
  return out;
}

// ---------------------------------------------------------------------------
// Derived fields
// ---------------------------------------------------------------------------

export const RARITY_MAP = { common: 0, uncommon: 1, rare: 2, mythic: 3, special: 4, bonus: 4 };

export function rarityCode(rarity) {
  return Object.prototype.hasOwnProperty.call(RARITY_MAP, rarity) ? RARITY_MAP[rarity] : 0;
}

const WUBRG = ['W', 'U', 'B', 'R', 'G'];

/** Color identity letters in WUBRG order, "" for colorless. */
export function colorIdentityString(card) {
  const ci = Array.isArray(card.color_identity) ? card.color_identity : [];
  const set = new Set(ci);
  return WUBRG.filter((c) => set.has(c)).join('');
}

const TYPE_BITS = {
  Creature: 1,
  Instant: 2,
  Sorcery: 4,
  Artifact: 8,
  Enchantment: 16,
  Planeswalker: 32,
  Land: 64,
  Battle: 128,
};
const LEGENDARY_BIT = 256;

/** Type-line bitmask per SPEC idx 13 (includes the Legendary bit). */
export function typeBitmask(card) {
  let typeLine = card.type_line;
  if (!typeLine && Array.isArray(card.card_faces) && card.card_faces[0]) {
    typeLine = card.card_faces[0].type_line;
  }
  typeLine = typeLine || '';
  // Front face only, before the em dash separating types from subtypes.
  const front = typeLine.split('//')[0];
  const beforeDash = front.split('—')[0];
  let mask = 0;
  for (const [word, bit] of Object.entries(TYPE_BITS)) {
    if (beforeDash.includes(word)) mask |= bit;
  }
  if (beforeDash.includes('Legendary')) mask |= LEGENDARY_BIT;
  return mask;
}

/** Year of a `released_at` (YYYY-MM-DD) string, or null. */
export function releasedYear(card) {
  if (typeof card.released_at !== 'string') return null;
  const y = parseInt(card.released_at.slice(0, 4), 10);
  return Number.isFinite(y) ? y : null;
}

const IMG_PREFIX_RE = /^https:\/\/cards\.scryfall\.io\/normal\/(.+)$/;

/** "<face>/<a>/<b>/<id>.jpg?<ts>" image key for the `normal` size, or "". */
export function imageKey(card) {
  let url = card.image_uris && card.image_uris.normal;
  if (!url && Array.isArray(card.card_faces) && card.card_faces[0]) {
    url = card.card_faces[0].image_uris && card.card_faces[0].image_uris.normal;
  }
  if (!url) return '';
  const m = IMG_PREFIX_RE.exec(url);
  return m ? m[1] : '';
}

// ---------------------------------------------------------------------------
// Streaming: resolve a source (url or local path, possibly gzip) to a local
// file, then stream the top-level JSON array calling `onCard` per element.
// ---------------------------------------------------------------------------

/** Download `url` to a local temp file (streamed, not buffered) and return its path. */
export async function downloadToTempFile(url, { userAgent, accept } = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': userAgent || USER_AGENT,
      Accept: accept || '*/*',
    },
  });
  if (!res.ok) {
    throw new Error(`download failed: ${res.status} ${res.statusText} (${url})`);
  }
  const tmp = path.join(
    os.tmpdir(),
    `mana-market-${crypto.randomBytes(6).toString('hex')}.download`,
  );
  await streamPipeline(res.body, fs.createWriteStream(tmp));
  return tmp;
}

/**
 * Resolve `source` (an http(s) URL or a local file path) to a local file
 * path suitable for repeated streaming reads. URLs are downloaded once to a
 * temp file; local paths are used as-is. Returns { path, cleanup, isTemp }.
 */
export async function resolveLocalFile(source, opts = {}) {
  if (/^https?:\/\//i.test(source)) {
    const p = await downloadToTempFile(source, opts);
    return { path: p, isTemp: true, cleanup: () => fs.promises.unlink(p).catch(() => {}) };
  }
  return { path: source, isTemp: false, cleanup: async () => {} };
}

/** True when the file starts with the gzip magic number (1f 8b). */
export function isGzipFile(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(2);
    const read = fs.readSync(fd, head, 0, 2, 0);
    return read === 2 && head[0] === 0x1f && head[1] === 0x8b;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

/** A readable stream of the file's decompressed bytes. */
function openDecompressed(filePath) {
  const raw = fs.createReadStream(filePath);
  if (isGzipFile(filePath) || String(filePath).endsWith('.gz')) {
    return raw.pipe(zlib.createGunzip());
  }
  return raw;
}

/**
 * Which JSON shape the file holds: 'array' for one big `[ {...}, {...} ]`,
 * 'lines' for JSON Lines (one object per line).
 *
 * Scryfall served bulk data as a JSON array for years and switched to
 * `.jsonl.gz`, so the format is sniffed from the first non-whitespace
 * character rather than assumed or read off the file name.
 */
export async function detectJsonShape(filePath) {
  const stream = openDecompressed(filePath);
  try {
    for await (const chunk of stream) {
      const text = chunk.toString('utf8');
      for (const ch of text) {
        if (/\s/.test(ch)) continue;
        return ch === '[' ? 'array' : 'lines';
      }
    }
  } finally {
    stream.destroy();
  }
  throw new Error(`${filePath} is empty — nothing to parse`);
}

/**
 * Stream every card in a Scryfall bulk file, calling `onCard(card)` per record.
 * Handles both shapes (JSON array and JSON Lines) and both encodings (plain and
 * gzip), detected from the content itself.
 */
export async function streamCardArray(filePath, onCard) {
  const shape = await detectJsonShape(filePath);
  if (shape === 'lines') return streamJsonLines(filePath, onCard);

  const pipeline = openDecompressed(filePath).pipe(parser()).pipe(streamArray());
  await new Promise((resolve, reject) => {
    pipeline.on('data', ({ value }) => {
      try {
        onCard(value);
      } catch (err) {
        pipeline.destroy(err);
      }
    });
    pipeline.on('end', resolve);
    pipeline.on('error', reject);
  });
  return undefined;
}

/** JSON Lines: one card per line, blank lines and CRLF tolerated. */
async function streamJsonLines(filePath, onCard) {
  const rl = readline.createInterface({
    input: openDecompressed(filePath),
    crlfDelay: Infinity,
  });
  let lineNo = 0;
  try {
    for await (const line of rl) {
      lineNo += 1;
      const trimmed = line.trim().replace(/,$/, '');
      if (!trimmed || trimmed === '[' || trimmed === ']') continue;
      let card;
      try {
        card = JSON.parse(trimmed);
      } catch (err) {
        throw new Error(`${filePath}: line ${lineNo} is not valid JSON (${err.message})`);
      }
      onCard(card);
    }
  } finally {
    rl.close();
  }
  return undefined;
}

/**
 * Stream the entries of one object inside a large JSON file (used by the
 * MTGJSON seed, whose files are `{ "data": { "<uuid>": {...}, ... } }`).
 * Compression is detected from the content, like everywhere else here.
 */
export async function streamObjectEntries(filePath, objectKey, onEntry) {
  const pipeline = openDecompressed(filePath)
    .pipe(parser())
    .pipe(pick({ filter: objectKey }))
    .pipe(streamObject());
  await new Promise((resolve, reject) => {
    pipeline.on('data', ({ key, value }) => {
      try {
        onEntry(key, value);
      } catch (err) {
        pipeline.destroy(err);
      }
    });
    pipeline.on('end', resolve);
    pipeline.on('error', reject);
  });
}

export async function buildSnapshotFromBulk(source, opts = {}) {
  const { log = () => {} } = opts;
  const resolved = await resolveLocalFile(source, opts);
  let printingsSeen = 0;
  let printingsExcluded = 0;
  let cardsSkippedNoPrice = 0;

  try {
    // Pass 1: which oracle_ids have at least one English printing, among
    // printings that pass the non-language universe filters.
    const hasEnglish = new Set();
    await streamCardArray(resolved.path, (card) => {
      if (!passesTypeFilter(card)) return;
      if (card.lang === 'en') hasEnglish.add(card.oracle_id);
    });
    log(`pass 1 complete: ${hasEnglish.size} oracle_ids have an English printing`);

    // Pass 2: aggregate cheapest/most-expensive printing+finish per oracle.
    const agg = new Map();
    const setNames = new Map();

    await streamCardArray(resolved.path, (card) => {
      if (!passesTypeFilter(card)) return;
      const oid = card.oracle_id;
      if (!oid) return;
      const langOk = card.lang === 'en' || !hasEnglish.has(oid);
      if (!langOk) {
        printingsExcluded++;
        return;
      }
      printingsSeen++;
      if (card.set && card.set_name && !setNames.has(card.set)) {
        setNames.set(card.set, card.set_name);
      }

      let state = agg.get(oid);
      if (!state) {
        state = {
          oracleId: oid,
          name: card.name,
          lo: null,
          loId: null,
          loF: null,
          loS: null,
          loCard: null,
          hi: null,
          hiId: null,
          hiF: null,
          hiS: null,
          np: 0,
          reserved: false,
          yr: null,
        };
        agg.set(oid, state);
      }
      state.np += 1;
      if (card.reserved === true) state.reserved = true;
      const y = releasedYear(card);
      if (y !== null && (state.yr === null || y < state.yr)) state.yr = y;

      const points = printingPricePoints(card);
      for (const { finish, cents } of points) {
        if (state.lo === null || cents < state.lo) {
          state.lo = cents;
          state.loId = card.id;
          state.loF = finish;
          state.loS = card.set;
          state.loCard = card;
        }
        if (state.hi === null || cents > state.hi) {
          state.hi = cents;
          state.hiId = card.id;
          state.hiF = finish;
          state.hiS = card.set;
        }
      }
    });
    log(`pass 2 complete: ${agg.size} oracle_ids seen, ${printingsSeen} tracked printings`);

    const rows = [];
    for (const state of agg.values()) {
      if (state.lo === null || state.hi === null) {
        cardsSkippedNoPrice++;
        continue; // no usable price anywhere -> skip entirely
      }
      const loCard = state.loCard;
      rows.push({
        oracleId: state.oracleId,
        name: state.name,
        lo: state.lo,
        loId: state.loId,
        loF: state.loF,
        loS: state.loS,
        hi: state.hi,
        hiId: state.hiId,
        hiF: state.hiF,
        hiS: state.hiS,
        np: state.np,
        r: rarityCode(loCard.rarity),
        cid: colorIdentityString(loCard),
        t: typeBitmask(loCard),
        res: state.reserved ? 1 : 0,
        yr: state.yr || 0,
        img: imageKey(loCard),
        cn: loCard.collector_number || '',
        edh: typeof loCard.edhrec_rank === 'number' ? loCard.edhrec_rank : 0,
        setName: setNames.get(state.loS) || state.loS,
      });
    }
    rows.sort((a, b) => (a.oracleId < b.oracleId ? -1 : a.oracleId > b.oracleId ? 1 : 0));

    return {
      rows,
      setNames,
      stats: {
        oracleIdsKept: rows.length,
        oracleIdsSkippedNoPrice: cardsSkippedNoPrice,
        printingsTracked: printingsSeen,
        printingsExcludedNonEnglish: printingsExcluded,
      },
    };
  } finally {
    await resolved.cleanup();
  }
}

// ---------------------------------------------------------------------------
// Bulk-data API resolution (picks the `default_cards` object)
// ---------------------------------------------------------------------------

export const USER_AGENT = process.env.SCRYFALL_UA
  || 'ManaMarket/1.0 (+https://github.com/NoahValentine/mana-market)';

export async function resolveDefaultCardsBulk({
  bulkApiUrl = 'https://api.scryfall.com/bulk-data',
  userAgent = USER_AGENT,
} = {}) {
  const res = await fetch(bulkApiUrl, {
    headers: { 'User-Agent': userAgent, Accept: 'application/json;q=0.9,*/*;q=0.8' },
  });
  if (!res.ok) {
    // Say what Scryfall actually said — a bare status code is useless in CI.
    let detail = '';
    try {
      const body = (await res.text()).slice(0, 400).replace(/\s+/g, ' ');
      if (body) detail = ` — body: ${body}`;
    } catch { /* no body */ }
    const server = res.headers.get('server') || 'unknown';
    throw new Error(
      `bulk-data list failed: ${res.status} ${res.statusText} (server: ${server}, `
      + `user-agent sent: ${userAgent})${detail}`,
    );
  }
  const body = await res.json();
  const obj = (body.data || []).find((d) => d.type === 'default_cards');
  if (!obj) {
    const types = (body.data || []).map((d) => d.type).join(', ') || '(none)';
    throw new Error(`no default_cards object in bulk-data response; types offered: ${types}`);
  }
  const url = pickDownloadUrl(obj);
  if (!url) {
    throw new Error(
      'could not find a download URL on the default_cards bulk object. '
      + `Fields present: ${Object.keys(obj).join(', ')}. `
      + 'Scryfall may have renamed the field — see pickDownloadUrl().',
    );
  }
  return { ...obj, download_uri: url };
}

/**
 * Find the bulk file's URL without depending on one field name.
 *
 * Scryfall called it `download_uri` historically; a rename broke the nightly
 * job once already, so identify it by shape: a string URL that is not the
 * object's own API self-link. Named candidates are tried first, then any
 * https URL pointing at the bulk file host, then any https URL ending in .json.
 */
export function pickDownloadUrl(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const named = ['download_uri', 'download_url', 'downloadUri', 'downloadUrl', 'file_uri', 'file_url'];
  for (const key of named) {
    const v = obj[key];
    if (typeof v === 'string' && /^https?:\/\//.test(v)) return v;
  }
  const values = Object.entries(obj)
    .filter(([key, v]) => typeof v === 'string' && /^https?:\/\//.test(v)
      // `uri` is the object's own API endpoint, not the data file
      && key !== 'uri' && !/^https?:\/\/api\.scryfall\.com\//.test(v));
  const onDataHost = values.find(([, v]) => /^https?:\/\/data\.scryfall\.io\//.test(v));
  if (onDataHost) return onDataHost[1];
  const jsonFile = values.find(([, v]) => /\.json(\.gz)?(\?|$)/.test(v));
  return jsonFile ? jsonFile[1] : null;
}
