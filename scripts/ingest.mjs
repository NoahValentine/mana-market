#!/usr/bin/env node
// scripts/ingest.mjs
//
// Nightly daily-snapshot ingest. Downloads (or reads, via --source) the
// Scryfall `default_cards` bulk file, computes the cheapest/most-expensive
// paper printing+finish per oracle_id, and writes `history/<day>.csv`.
//
// Usage:
//   node scripts/ingest.mjs [--source <url-or-path>] [--day YYYY-MM-DD] [--out history/]
//
// --source defaults to resolving https://api.scryfall.com/bulk-data and
// downloading the `default_cards` object's `download_uri`. Pass a local
// file path (plain or .gz) or a direct URL to override, e.g. for fixtures:
//   node scripts/ingest.mjs --source fixtures/scryfall-default-cards.json --day 2026-06-05
//
// Idempotent: re-running for the same --day overwrites only that day's file.

import fs from 'node:fs';
import { buildSnapshotFromBulk, resolveDefaultCardsBulk } from './lib/scryfall.mjs';
import { writeCsvFile } from './lib/csv.mjs';

function parseArgs(argv) {
  const args = { out: 'history' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source') args.source = argv[++i];
    else if (a === '--day') args.day = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--help') args.help = true;
  }
  return args;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export async function run(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('Usage: node scripts/ingest.mjs [--source url|file] [--day YYYY-MM-DD] [--out history/]');
    return;
  }
  const day = args.day || todayIso();

  let source = args.source;
  let bulkUpdatedAt = null;
  if (!source) {
    console.log('Resolving Scryfall bulk-data (default_cards)...');
    const obj = await resolveDefaultCardsBulk();
    source = obj.download_uri;
    bulkUpdatedAt = obj.updated_at;
    console.log(`  -> ${source} (updated_at ${bulkUpdatedAt})`);
  }

  const { rows, stats } = await buildSnapshotFromBulk(source, {
    log: (msg) => console.log(`  ${msg}`),
  });

  const csvRows = rows.map((r) => ({
    oracleId: r.oracleId,
    loCents: r.lo,
    loPrinting: r.loId,
    loFinish: r.loF,
    hiCents: r.hi,
    hiPrinting: r.hiId,
    hiFinish: r.hiF,
  }));

  const outPath = `${args.out.replace(/\/$/, '')}/${day}.csv`;
  writeCsvFile(outPath, csvRows);

  console.log('');
  console.log(`Ingest summary for ${day}`);
  console.log(`  cards kept:    ${stats.oracleIdsKept}`);
  console.log(`  cards skipped (no usable price): ${stats.oracleIdsSkippedNoPrice}`);
  console.log(`  printings tracked: ${stats.printingsTracked}`);
  console.log(`  non-English printings excluded: ${stats.printingsExcludedNonEnglish}`);
  if (bulkUpdatedAt) console.log(`  bulk updated_at: ${bulkUpdatedAt}`);
  console.log(`  wrote: ${outPath}`);

  return { day, outPath, stats, bulkUpdatedAt };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
