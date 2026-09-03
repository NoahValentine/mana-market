#!/usr/bin/env node
// scripts/build-pack.mjs
//
// Reads the newest snapshot (a fresh Scryfall bulk parse -- gives us name,
// image, type, rarity, etc.) plus the newest <=90 `history/<day>.csv` files
// (gives us the time series for percent-change math and series.bin), and
// writes public/data/{meta.json, cards.json, series.bin, trends.json}.
//
// Usage:
//   node scripts/build-pack.mjs [--source url|file] [--history-dir history/]
//     [--out public/data] [--min-cents 50] [--max-days 90] [--bulk-updated-at ISO]
//
// --source defaults to resolving the live Scryfall bulk-data API, same as
// ingest.mjs. For fixtures, pass the same --source file used for ingest so
// "today" in the snapshot lines up with the newest history/<day>.csv.

import fs from 'node:fs';
import path from 'node:path';
import { buildSnapshotFromBulk, resolveDefaultCardsBulk } from './lib/scryfall.mjs';
import { readCsvFileAsMap, listHistoryDays } from './lib/csv.mjs';

const WINDOWS = [1, 7, 30, 90];
const MOVERS_MIN_CENTS = 100; // $1.00 -- SPEC "Cards below movers_min_cents ($1.00)..."
const MOVERS_PCT_THRESHOLD = 500; // ×100 percent, i.e. 5.00%

function parseArgs(argv) {
  const args = {
    historyDir: 'history',
    out: 'public/data',
    minCents: 50,
    maxDays: 90,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source') args.source = argv[++i];
    else if (a === '--history-dir') args.historyDir = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--min-cents') args.minCents = parseInt(argv[++i], 10);
    else if (a === '--max-days') args.maxDays = parseInt(argv[++i], 10);
    else if (a === '--bulk-updated-at') args.bulkUpdatedAt = argv[++i];
    else if (a === '--help') args.help = true;
  }
  return args;
}

/** now/then in cents (or -1 for missing) -> integer percent×100, or null. */
export function pctChange(nowCents, thenCents) {
  if (nowCents === -1 || thenCents === -1 || thenCents === null || thenCents === undefined) {
    return null;
  }
  if (thenCents <= 0) return null;
  return Math.round(((nowCents - thenCents) / thenCents) * 10000);
}

/** SPEC: "require Math.max(now, then) >= movers_min_cents" to exclude penny-card noise. */
export function eligibleForMovers(nowCents, thenCents, minCents = MOVERS_MIN_CENTS) {
  if (thenCents === null || thenCents === undefined || thenCents === -1) return false;
  if (nowCents === null || nowCents === undefined || nowCents === -1) return false;
  return Math.max(nowCents, thenCents) >= minCents;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

function isoDaysBack(dayStr, n) {
  const d = new Date(`${dayStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export async function run(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(
      'Usage: node scripts/build-pack.mjs [--source url|file] [--history-dir history/] [--out public/data] [--min-cents 50] [--max-days 90]',
    );
    return;
  }

  let source = args.source;
  let bulkUpdatedAt = args.bulkUpdatedAt || null;
  if (!source) {
    console.log('Resolving Scryfall bulk-data (default_cards)...');
    const obj = await resolveDefaultCardsBulk();
    source = obj.download_uri;
    bulkUpdatedAt = bulkUpdatedAt || obj.updated_at;
  }

  console.log(`Building snapshot from ${source} ...`);
  const { rows: snapshotRows, setNames } = await buildSnapshotFromBulk(source, {
    log: (m) => console.log(`  ${m}`),
  });

  if (!bulkUpdatedAt) {
    bulkUpdatedAt = fs.existsSync(source)
      ? fs.statSync(source).mtime.toISOString()
      : new Date().toISOString();
  }

  const tracked = snapshotRows.filter((r) => r.lo >= args.minCents);
  console.log(
    `Snapshot: ${snapshotRows.length} oracle_ids, ${tracked.length} at/above ${args.minCents} cents`,
  );

  // ---- history days ----
  // series.bin/meta.json/days only ever cover the newest `maxDays` files
  // (per SPEC, cols is capped at 90). But computing "% vs N days ago" for
  // the *oldest* window (N == maxDays) needs one more day beyond that visible
  // range as its baseline -- otherwise the last window is structurally
  // unsatisfiable (today minus 90 days falls one day before a 90-column
  // matrix that ends today). So we additionally load a lookback buffer of
  // older day files (up to the largest window size) purely to resolve
  // percent-change baselines; they never appear in `days` or series.bin.
  const allDayFiles = listHistoryDays(args.historyDir); // ascending
  if (allDayFiles.length === 0) {
    throw new Error(`no history/<day>.csv files found under ${args.historyDir}`);
  }
  const visibleFiles = allDayFiles.slice(-args.maxDays);
  const days = visibleFiles.map((d) => d.day);
  console.log(`History: using ${days.length} day file(s), ${days[0]} .. ${days[days.length - 1]}`);

  const lookbackBudget = Math.max(...WINDOWS);
  const olderFiles = allDayFiles.slice(0, allDayFiles.length - visibleFiles.length);
  const lookbackFiles = olderFiles.slice(-lookbackBudget);

  const dayMaps = [];
  for (const { path: p } of visibleFiles) {
    dayMaps.push(await readCsvFileAsMap(p));
  }
  const dayIndex = new Map(days.map((d, i) => [d, i]));

  // day -> Map(oracleId -> row) for days older than the visible window,
  // used only to look up "then" values for the largest windows.
  const lookbackMaps = new Map();
  for (const { day, path: p } of lookbackFiles) {
    lookbackMaps.set(day, await readCsvFileAsMap(p));
  }

  /** lo_cents for `oracleId` on `day`, or -1 if that day has no data for it, or null if the day is entirely out of range. */
  function loCentsOnDay(oracleId, day) {
    if (dayIndex.has(day)) {
      const row = dayMaps[dayIndex.get(day)].get(oracleId);
      return row ? row.loCents : -1;
    }
    if (lookbackMaps.has(day)) {
      const row = lookbackMaps.get(day).get(oracleId);
      return row ? row.loCents : -1;
    }
    return null; // day not loaded at all -> can't say
  }

  // ---- sort rows by lo DESC (stable tie-break by oracle_id) and assign row index ----
  tracked.sort((a, b) => (b.lo !== a.lo ? b.lo - a.lo : a.oracleId < b.oracleId ? -1 : 1));
  tracked.forEach((r, i) => {
    r.row = i;
  });

  // ---- series.bin ----
  const cols = days.length;
  const rowsCount = tracked.length;
  const seriesBuf = Buffer.alloc(rowsCount * cols * 4);
  for (const r of tracked) {
    const base = r.row * cols * 4;
    for (let j = 0; j < cols; j++) {
      const dm = dayMaps[j].get(r.oracleId);
      const cents = dm ? dm.loCents : -1;
      seriesBuf.writeInt32LE(cents, base + j * 4);
    }
  }

  function seriesAt(row, col) {
    return seriesBuf.readInt32LE(row * cols * 4 + col * 4);
  }

  const lastCol = cols - 1;
  const lastDay = days[lastCol];

  for (const r of tracked) {
    const now = seriesAt(r.row, lastCol);
    for (const w of WINDOWS) {
      const targetDay = isoDaysBack(lastDay, w);
      const then = loCentsOnDay(r.oracleId, targetDay);
      r[`d${w}`] = pctChange(now, then);
    }
  }

  // ---- cards.json ----
  const fields = [
    'oid', 'n', 'lo', 'loId', 'loF', 'loS', 'hi', 'hiId', 'hiF', 'hiS',
    'np', 'r', 'cid', 't', 'res', 'yr', 'd1', 'd7', 'd30', 'd90', 'row', 'img', 'cn', 'edh',
  ];
  const cardsRows = tracked.map((r) => [
    r.oracleId, r.name, r.lo, r.loId, r.loF, r.loS, r.hi, r.hiId, r.hiF, r.hiS,
    r.np, r.r, r.cid, r.t, r.res, r.yr, r.d1, r.d7, r.d30, r.d90, r.row, r.img, r.cn, r.edh,
  ]);

  // ---- trends.json: windows (gainers/losers) ----
  const windows = {};
  for (const w of WINDOWS) {
    const key = `d${w}`;
    const eligible = [];
    for (const r of tracked) {
      const pct = r[key];
      if (pct === null) continue;
      const now = seriesAt(r.row, lastCol);
      const targetDay = isoDaysBack(lastDay, w);
      const then = loCentsOnDay(r.oracleId, targetDay);
      if (!eligibleForMovers(now, then)) continue;
      eligible.push([r.oracleId, pct, now, then]);
    }
    const gainers = eligible
      .filter((e) => e[1] > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 200);
    const losers = eligible
      .filter((e) => e[1] < 0)
      .sort((a, b) => a[1] - b[1])
      .slice(0, 200);
    windows[key] = { gainers, losers };
  }

  // ---- trends.json: index block ----
  // A missing snapshot day must not look like a price crash: carry the last
  // known price forward (and back-fill leading holes) before summing.
  const filled = new Map(); // row -> Int32Array with no -1 holes
  const filledFor = (row) => {
    let arr = filled.get(row);
    if (arr) return arr;
    arr = new Int32Array(cols);
    let last = -1;
    for (let j = 0; j < cols; j++) {
      const v = seriesAt(row, j);
      if (v !== -1) last = v;
      arr[j] = last;
    }
    // back-fill the leading gap with the first value we ever saw
    let first = -1;
    for (let j = 0; j < cols; j++) { if (arr[j] !== -1) { first = arr[j]; break; } }
    for (let j = 0; j < cols && arr[j] === -1; j++) arr[j] = first;
    filled.set(row, arr);
    return arr;
  };
  const filledAt = (row, j) => {
    const v = filledFor(row)[j];
    return v === undefined ? -1 : v;
  };

  const top100Rows = tracked.slice(0, 100);
  const top1000Rows = tracked.slice(0, 1000);
  const top100 = [];
  const top1000 = [];
  const medianArr = [];
  const moversUp = [];
  const moversDown = [];
  for (let j = 0; j < cols; j++) {
    let sum100 = 0;
    for (const r of top100Rows) {
      const v = filledAt(r.row, j);
      if (v !== -1) sum100 += v;
    }
    top100.push(sum100);

    let sum1000 = 0;
    for (const r of top1000Rows) {
      const v = filledAt(r.row, j);
      if (v !== -1) sum1000 += v;
    }
    top1000.push(sum1000);

    const colValues = [];
    for (const r of tracked) {
      const v = filledAt(r.row, j);
      if (v !== -1) colValues.push(v);
    }
    medianArr.push(median(colValues));

    if (j === 0) {
      moversUp.push(0);
      moversDown.push(0);
    } else {
      let up = 0;
      let down = 0;
      for (const r of tracked) {
        const now = seriesAt(r.row, j);
        const then = seriesAt(r.row, j - 1);
        const pct = pctChange(now, then);
        if (pct === null) continue;
        if (!eligibleForMovers(now, then)) continue;
        if (pct > MOVERS_PCT_THRESHOLD) up++;
        else if (pct < -MOVERS_PCT_THRESHOLD) down++;
      }
      moversUp.push(up);
      moversDown.push(down);
    }
  }

  // ---- trends.json: per-set totals ----
  const setTotals = new Map(); // code -> { total, then }
  for (const r of tracked) {
    const code = r.loS;
    let s = setTotals.get(code);
    if (!s) {
      s = { code, name: setNames.get(code) || code, total: 0, then: 0 };
      setTotals.set(code, s);
    }
    s.total += r.lo;
    const day7 = isoDaysBack(lastDay, 7);
    const col7 = dayIndex.get(day7);
    if (col7 !== undefined) {
      const v = seriesAt(r.row, col7);
      if (v !== -1) s.then += v;
    }
  }
  const sets = [...setTotals.values()]
    .map((s) => ({
      code: s.code,
      name: s.name,
      total: s.total,
      d7: s.then > 0 ? pctChange(s.total, s.then) : 0,
    }))
    .sort((a, b) => b.total - a.total);

  const trends = {
    generated_at: new Date().toISOString(),
    windows,
    movers_min_cents: MOVERS_MIN_CENTS,
    index: {
      days,
      top100,
      top1000,
      median: medianArr,
      movers_up: moversUp,
      movers_down: moversDown,
    },
    sets,
  };

  const meta = {
    generated_at: new Date().toISOString(),
    scryfall_bulk_updated_at: bulkUpdatedAt,
    days,
    card_count: tracked.length,
    min_tracked_cents: args.minCents,
    series: { rows: rowsCount, cols, bytes_per_value: 4, row_bytes: cols * 4 },
    index_windows: WINDOWS,
  };

  // ---- write output ----
  fs.mkdirSync(args.out, { recursive: true });
  fs.writeFileSync(path.join(args.out, 'meta.json'), JSON.stringify(meta));
  fs.writeFileSync(path.join(args.out, 'cards.json'), JSON.stringify({ fields, rows: cardsRows }));
  fs.writeFileSync(path.join(args.out, 'series.bin'), seriesBuf);
  fs.writeFileSync(path.join(args.out, 'trends.json'), JSON.stringify(trends));

  console.log('');
  console.log('build-pack summary');
  console.log('  metric               value');
  console.log('  ------               -----');
  console.log(`  tracked cards        ${tracked.length}`);
  console.log(`  history days         ${cols} (${days[0]} .. ${lastDay})`);
  console.log(`  series.bin bytes     ${seriesBuf.length}`);
  console.log(`  gainers d1/d7/d30/d90 ${WINDOWS.map((w) => windows[`d${w}`].gainers.length).join('/')}`);
  console.log(`  losers  d1/d7/d30/d90 ${WINDOWS.map((w) => windows[`d${w}`].losers.length).join('/')}`);
  console.log(`  sets tracked         ${sets.length}`);

  return { meta, cardsCount: cardsRows.length, trends };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
