#!/usr/bin/env node
// scripts/seed-mtgjson.mjs
//
// One-time 90-day history backfill from MTGJSON v5, so a brand-new deploy
// doesn't have to wait 90 days for `series.bin`/`trends.json` to fill up.
//
// MTGJSON has no Scryfall ids in AllPrices.json, so this streams TWO files:
//   1. AllIdentifiers.json.gz  -> data[uuid].identifiers.{scryfallId,scryfallOracleId}
//      built into an in-memory uuid -> {scryfallId, oracleId} map first
//      (bounded by MTGJSON's card count, ~90k entries, a few MB).
//   2. AllPrices.json.gz       -> data[uuid].paper.tcgplayer.retail.{normal,foil,etched}["YYYY-MM-DD"]
//      streamed once; for every (uuid, day, price) triple we look up the
//      uuid in the identifiers map and fold it into a per-day, per-oracle_id
//      {lo, hi} aggregate (same shape as ingest.mjs's daily snapshot).
//
// Expected runtime/RAM (documented per task spec): AllPrices.json.gz is
// ~150-250MB compressed / ~1.5-2.5GB uncompressed as of 2026, AllIdentifiers
// is smaller (~40-80MB compressed). Both are gunzipped and JSON-streamed
// (never buffered whole), so peak RSS is dominated by the per-day/per-oracle
// aggregate map, not file size -- expect well under 1GB RAM and 5-15 minutes
// on a GitHub-hosted runner (2 vCPU). This comfortably fits the ~14GB disk /
// 7GB RAM budget noted for the seed.yml runner.
//
// Usage:
//   node scripts/seed-mtgjson.mjs \
//     [--source-prices <url-or-path>] [--source-identifiers <url-or-path>] \
//     [--out history/] [--force] [--limit-days N]
//
// Defaults: --source-prices https://mtgjson.com/api/v5/AllPrices.json.gz
//           --source-identifiers https://mtgjson.com/api/v5/AllIdentifiers.json.gz
// Never overwrites a day file that already exists unless --force.

import fs from 'node:fs';
import { resolveLocalFile, streamObjectEntries, FINISH } from './lib/scryfall.mjs';
import { writeCsvFile } from './lib/csv.mjs';

const DEFAULT_PRICES = 'https://mtgjson.com/api/v5/AllPrices.json.gz';
const DEFAULT_IDENTIFIERS = 'https://mtgjson.com/api/v5/AllIdentifiers.json.gz';

function parseArgs(argv) {
  const args = { out: 'history', force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source-prices') args.sourcePrices = argv[++i];
    else if (a === '--source-identifiers') args.sourceIdentifiers = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--force') args.force = true;
    else if (a === '--limit-days') args.limitDays = parseInt(argv[++i], 10);
    else if (a === '--help') args.help = true;
  }
  return args;
}

/** Build uuid -> { scryfallId, oracleId } from AllIdentifiers.json(.gz). */
async function buildIdentifierMap(source) {
  const resolved = await resolveLocalFile(source);
  const map = new Map();
  try {
    await streamObjectEntries(resolved.path, 'data', (uuid, value) => {
      const ids = value && value.identifiers;
      if (!ids) return;
      const scryfallId = ids.scryfallId;
      const oracleId = ids.scryfallOracleId;
      if (scryfallId && oracleId) {
        map.set(uuid, { scryfallId, oracleId });
      }
    });
  } finally {
    await resolved.cleanup();
  }
  return map;
}

function updateExtremes(dayBucket, oracleId, cents, finish, printingId) {
  let state = dayBucket.get(oracleId);
  if (!state) {
    state = { lo: null, loId: null, loF: null, hi: null, hiId: null, hiF: null };
    dayBucket.set(oracleId, state);
  }
  if (state.lo === null || cents < state.lo) {
    state.lo = cents;
    state.loId = printingId;
    state.loF = finish;
  }
  if (state.hi === null || cents > state.hi) {
    state.hi = cents;
    state.hiId = printingId;
    state.hiF = finish;
  }
}

const RETAIL_FINISHES = [
  ['normal', FINISH.NONFOIL],
  ['foil', FINISH.FOIL],
  ['etched', FINISH.ETCHED],
];

/**
 * Stream AllPrices.json(.gz), returning Map<day, Map<oracleId, extremes>>.
 */
async function buildDailyAggregates(source, idMap, { log = () => {} } = {}) {
  const resolved = await resolveLocalFile(source);
  const byDay = new Map();
  let uuidsMatched = 0;
  let uuidsUnmatched = 0;
  try {
    await streamObjectEntries(resolved.path, 'data', (uuid, value) => {
      const ids = idMap.get(uuid);
      if (!ids) {
        uuidsUnmatched++;
        return;
      }
      const retail = value && value.paper && value.paper.tcgplayer && value.paper.tcgplayer.retail;
      if (!retail) return;
      uuidsMatched++;
      for (const [key, finish] of RETAIL_FINISHES) {
        const byDayPrice = retail[key];
        if (!byDayPrice) continue;
        for (const [day, price] of Object.entries(byDayPrice)) {
          const cents = Math.round(parseFloat(price) * 100);
          if (!Number.isFinite(cents)) continue;
          let bucket = byDay.get(day);
          if (!bucket) {
            bucket = new Map();
            byDay.set(day, bucket);
          }
          updateExtremes(bucket, ids.oracleId, cents, finish, ids.scryfallId);
        }
      }
    });
  } finally {
    await resolved.cleanup();
  }
  log(`AllPrices streamed: ${uuidsMatched} uuids matched to Scryfall ids, ${uuidsUnmatched} unmatched`);
  return byDay;
}

export async function run(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(
      'Usage: node scripts/seed-mtgjson.mjs [--source-prices url|file] [--source-identifiers url|file] [--out history/] [--force] [--limit-days N]',
    );
    return;
  }

  const sourcePrices = args.sourcePrices || DEFAULT_PRICES;
  const sourceIdentifiers = args.sourceIdentifiers || DEFAULT_IDENTIFIERS;

  console.log(`Building identifier map from ${sourceIdentifiers} ...`);
  const idMap = await buildIdentifierMap(sourceIdentifiers);
  console.log(`  -> ${idMap.size} uuids with a Scryfall oracle/printing id`);

  console.log(`Streaming prices from ${sourcePrices} ...`);
  const byDay = await buildDailyAggregates(sourcePrices, idMap, {
    log: (m) => console.log(`  ${m}`),
  });

  let days = [...byDay.keys()].sort(); // ascending
  if (args.limitDays && days.length > args.limitDays) {
    days = days.slice(days.length - args.limitDays); // most recent N
  }

  const outDir = args.out.replace(/\/$/, '');
  let written = 0;
  let skippedExisting = 0;
  for (const day of days) {
    const outPath = `${outDir}/${day}.csv`;
    if (fs.existsSync(outPath) && !args.force) {
      skippedExisting++;
      continue;
    }
    const bucket = byDay.get(day);
    const rows = [...bucket.entries()].map(([oracleId, s]) => ({
      oracleId,
      loCents: s.lo,
      loPrinting: s.loId,
      loFinish: s.loF,
      hiCents: s.hi,
      hiPrinting: s.hiId,
      hiFinish: s.hiF,
    }));
    writeCsvFile(outPath, rows);
    written++;
  }

  console.log('');
  console.log('Seed summary');
  console.log(`  days covered by MTGJSON data: ${byDay.size}`);
  console.log(`  days selected: ${days.length}`);
  console.log(`  day files written: ${written}`);
  console.log(`  day files skipped (already existed, use --force to overwrite): ${skippedExisting}`);

  return { days, written, skippedExisting };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
