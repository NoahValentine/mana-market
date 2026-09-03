// test/pipeline.test.mjs
//
// Plain `node --test` coverage for the ingest -> seed -> build-pack chain.
// No framework deps. Run with `npm test`.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  usdToCents,
  printingPricePoints,
  passesTypeFilter,
  colorIdentityString,
  typeBitmask,
  rarityCode,
  imageKey,
  buildSnapshotFromBulk,
  FINISH,
} from '../scripts/lib/scryfall.mjs';
import { rowsToCsv, parseCsv, writeCsvFile, readCsvFile, listHistoryDays } from '../scripts/lib/csv.mjs';
import { pctChange, eligibleForMovers, run as runBuildPack } from '../scripts/build-pack.mjs';
import { run as runIngest } from '../scripts/ingest.mjs';
import { run as runSeed } from '../scripts/seed-mtgjson.mjs';
import { ruleCrossed } from '../scripts/send-alerts.mjs';
import { writeFixtures, ANCHOR_DAY } from '../fixtures/make-fixtures.mjs';

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mm-test-${name}-`));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// Cents rounding
// ---------------------------------------------------------------------------

test('usdToCents rounds to the nearest cent', () => {
  // Scryfall's `usd`/`usd_foil`/`usd_etched` are always 2-decimal dollar
  // strings; Math.round(parseFloat(x) * 100) is exact for those. (A literal
  // ".005" third-decimal input hits ordinary float representation error --
  // 1.005 is actually stored as ~1.00499999999999989 -- which isn't a shape
  // Scryfall ever sends, so it's intentionally not asserted here.)
  assert.equal(usdToCents('1.01'), 101);
  assert.equal(usdToCents('0.02'), 2);
  assert.equal(usdToCents('12000.00'), 1_200_000);
  assert.equal(usdToCents('3.999'), 400); // Math.round(399.9) = 400
  assert.equal(usdToCents(null), null);
  assert.equal(usdToCents(undefined), null);
  assert.equal(usdToCents('not-a-number'), null);
});

// ---------------------------------------------------------------------------
// Cheapest / most-expensive selection across finishes
// ---------------------------------------------------------------------------

test('printingPricePoints extracts nonfoil/foil/etched, skipping nulls', () => {
  const points = printingPricePoints({
    prices: { usd: '1.00', usd_foil: '2.50', usd_etched: null },
  });
  assert.deepEqual(points, [
    { finish: FINISH.NONFOIL, cents: 100 },
    { finish: FINISH.FOIL, cents: 250 },
  ]);
});

test('printingPricePoints returns [] when every price is null', () => {
  assert.deepEqual(printingPricePoints({ prices: { usd: null, usd_foil: null, usd_etched: null } }), []);
  assert.deepEqual(printingPricePoints({ prices: {} }), []);
  assert.deepEqual(printingPricePoints({}), []);
});

test('buildSnapshotFromBulk picks the global cheapest/most-expensive printing+finish per oracle_id', async () => {
  const dir = tmpDir('cheapest');
  const oid = 'oracle-1';
  const cards = [
    // printing A: nonfoil 5.00, foil 12.00
    { id: 'a', oracle_id: oid, name: 'Test Card', lang: 'en', set: 'aaa', set_name: 'Set AAA',
      set_type: 'expansion', layout: 'normal', collector_number: '1', released_at: '2020-01-01',
      rarity: 'rare', type_line: 'Creature — Bear', color_identity: ['G'], games: ['paper'],
      prices: { usd: '5.00', usd_foil: '12.00', usd_etched: null } },
    // printing B: nonfoil 2.00 (new global min), etched 40.00 (new global max)
    { id: 'b', oracle_id: oid, name: 'Test Card', lang: 'en', set: 'bbb', set_name: 'Set BBB',
      set_type: 'expansion', layout: 'normal', collector_number: '2', released_at: '2021-01-01',
      rarity: 'common', type_line: 'Creature — Bear', color_identity: ['G'], games: ['paper'],
      prices: { usd: '2.00', usd_foil: null, usd_etched: '40.00' } },
  ];
  writeJson(path.join(dir, 'bulk.json'), cards);
  const { rows } = await buildSnapshotFromBulk(path.join(dir, 'bulk.json'));
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.lo, 200);
  assert.equal(row.loId, 'b');
  assert.equal(row.loF, FINISH.NONFOIL);
  assert.equal(row.loS, 'bbb');
  assert.equal(row.hi, 4000);
  assert.equal(row.hiId, 'b');
  assert.equal(row.hiF, FINISH.ETCHED);
  assert.equal(row.hiS, 'bbb');
  assert.equal(row.np, 2);
  // rarity/cid/type/img/cn are all taken from the CHEAPEST printing (b), per SPEC.
  assert.equal(row.r, rarityCode('common'));
  assert.equal(row.cn, '2');
});

// ---------------------------------------------------------------------------
// Exclusion rules
// ---------------------------------------------------------------------------

test('passesTypeFilter excludes digital, oversized, set types and layouts', () => {
  const base = { digital: false, oversized: false, set_type: 'expansion', layout: 'normal', games: ['paper'] };
  assert.equal(passesTypeFilter(base), true);
  assert.equal(passesTypeFilter({ ...base, digital: true }), false);
  assert.equal(passesTypeFilter({ ...base, oversized: true }), false);
  for (const set_type of ['memorabilia', 'token', 'minigame', 'alchemy']) {
    assert.equal(passesTypeFilter({ ...base, set_type }), false, `set_type ${set_type} should be excluded`);
  }
  for (const layout of ['token', 'double_faced_token', 'emblem', 'art_series', 'vanguard', 'scheme', 'planar']) {
    assert.equal(passesTypeFilter({ ...base, layout }), false, `layout ${layout} should be excluded`);
  }
  assert.equal(passesTypeFilter({ ...base, games: ['mtgo'] }), false);
});

test('non-English printing excluded when an English printing exists, kept when it is the sole printing', async () => {
  const dir = tmpDir('lang');
  const withEnglish = 'oracle-has-en';
  const onlyForeign = 'oracle-only-jp';
  const mkCard = (overrides) => ({
    id: overrides.id, oracle_id: overrides.oracle_id, name: 'X', lang: overrides.lang,
    set: 'aaa', set_name: 'Set', set_type: 'expansion', layout: 'normal',
    collector_number: overrides.id, released_at: '2020-01-01', rarity: 'common',
    type_line: 'Creature — Bear', color_identity: [], games: ['paper'],
    prices: { usd: '1.00', usd_foil: null, usd_etched: null },
  });
  const cards = [
    mkCard({ id: 'en1', oracle_id: withEnglish, lang: 'en' }),
    mkCard({ id: 'jp1', oracle_id: withEnglish, lang: 'ja' }),
    mkCard({ id: 'jp2', oracle_id: onlyForeign, lang: 'ja' }),
  ];
  writeJson(path.join(dir, 'bulk.json'), cards);
  const { rows, stats } = await buildSnapshotFromBulk(path.join(dir, 'bulk.json'));
  const byOid = Object.fromEntries(rows.map((r) => [r.oracleId, r]));
  assert.equal(byOid[withEnglish].np, 1, 'the Japanese printing of a card with an English printing is excluded');
  assert.equal(byOid[onlyForeign].np, 1, 'the sole Japanese-only printing is kept');
  assert.equal(stats.printingsExcludedNonEnglish, 1);
});

test('a card with no usable price anywhere is skipped entirely', async () => {
  const dir = tmpDir('nopricie');
  const cards = [
    { id: 'a', oracle_id: 'oid-nopricie', name: 'No Price Card', lang: 'en', set: 'aaa',
      set_name: 'Set', set_type: 'expansion', layout: 'normal', collector_number: '1',
      released_at: '2020-01-01', rarity: 'common', type_line: 'Land', color_identity: [],
      games: ['paper'], prices: { usd: null, usd_foil: null, usd_etched: null } },
  ];
  writeJson(path.join(dir, 'bulk.json'), cards);
  const { rows, stats } = await buildSnapshotFromBulk(path.join(dir, 'bulk.json'));
  assert.equal(rows.length, 0);
  assert.equal(stats.oracleIdsSkippedNoPrice, 1);
});

// ---------------------------------------------------------------------------
// Derived fields
// ---------------------------------------------------------------------------

test('colorIdentityString orders letters WUBRG and is empty for colorless', () => {
  assert.equal(colorIdentityString({ color_identity: ['R', 'W', 'G'] }), 'WRG');
  assert.equal(colorIdentityString({ color_identity: [] }), '');
  assert.equal(colorIdentityString({}), '');
});

test('typeBitmask sets the right bits, including Legendary, and falls back to card_faces[0]', () => {
  assert.equal(typeBitmask({ type_line: 'Creature — Bear' }), 1);
  assert.equal(typeBitmask({ type_line: 'Legendary Creature — Human Knight' }), 1 | 256);
  assert.equal(typeBitmask({ type_line: 'Land' }), 64);
  assert.equal(typeBitmask({ type_line: 'Instant' }), 2);
  assert.equal(typeBitmask({ type_line: 'Battle — Siege' }), 128);
  // multi-face card with no top-level type_line
  assert.equal(
    typeBitmask({ card_faces: [{ type_line: 'Creature — Human Scout' }, { type_line: 'Land' }] }),
    1,
  );
});

test('imageKey parses the path after the size segment, falls back to card_faces[0]', () => {
  assert.equal(
    imageKey({ image_uris: { normal: 'https://cards.scryfall.io/normal/front/a/b/xyz.jpg?123' } }),
    'front/a/b/xyz.jpg?123',
  );
  assert.equal(
    imageKey({ card_faces: [{ image_uris: { normal: 'https://cards.scryfall.io/normal/front/c/d/w.jpg?9' } }] }),
    'front/c/d/w.jpg?9',
  );
  assert.equal(imageKey({}), '');
});

// ---------------------------------------------------------------------------
// CSV round-trip
// ---------------------------------------------------------------------------

test('CSV round-trips through write/read and is sorted by oracle_id', () => {
  const dir = tmpDir('csv');
  const rows = [
    { oracleId: 'zzz', loCents: 100, loPrinting: 'p1', loFinish: 0, hiCents: 200, hiPrinting: 'p2', hiFinish: 1 },
    { oracleId: 'aaa', loCents: 50, loPrinting: 'p3', loFinish: 2, hiCents: 60, hiPrinting: 'p4', hiFinish: 0 },
  ];
  const file = path.join(dir, '2026-01-01.csv');
  writeCsvFile(file, rows);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^oracle_id,lo_cents,lo_printing,lo_finish,hi_cents,hi_printing,hi_finish\n/);
  const parsed = readCsvFile(file);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].oracleId, 'aaa'); // sorted ascending
  assert.equal(parsed[1].oracleId, 'zzz');
  assert.deepEqual(parsed[0], rows[1]);
  // re-serializing should reproduce identical text (stable round trip)
  assert.equal(rowsToCsv(parsed), text);
});

test('parseCsv rejects an unexpected header', () => {
  assert.throws(() => parseCsv('not,the,right,header\n1,2,3,4\n'));
});

test('listHistoryDays returns only well-formed day files, sorted ascending', () => {
  const dir = tmpDir('listdays');
  fs.mkdirSync(dir, { recursive: true });
  writeCsvFile(path.join(dir, '2026-02-01.csv'), []);
  writeCsvFile(path.join(dir, '2026-01-15.csv'), []);
  fs.writeFileSync(path.join(dir, 'not-a-day.csv'), 'junk');
  fs.writeFileSync(path.join(dir, 'README.md'), 'ignore me');
  const days = listHistoryDays(dir);
  assert.deepEqual(days.map((d) => d.day), ['2026-01-15', '2026-02-01']);
});

// ---------------------------------------------------------------------------
// Series / percent-change math, including missing days
// ---------------------------------------------------------------------------

test('pctChange computes ×100 integer percent and handles missing endpoints', () => {
  assert.equal(pctChange(88, 100), -1200); // -12.00%
  assert.equal(pctChange(112, 100), 1200); // +12.00%
  assert.equal(pctChange(100, 81), 2346); // +23.4567...% -> rounds to 2346
  assert.equal(pctChange(100, -1), null); // "then" missing (no data that day)
  assert.equal(pctChange(-1, 100), null); // "now" missing
  assert.equal(pctChange(100, null), null); // day not loaded at all
  assert.equal(pctChange(100, 0), null); // guard against div-by-zero
});

test('eligibleForMovers requires max(now, then) >= movers_min_cents and both known', () => {
  assert.equal(eligibleForMovers(50, 200, 100), true); // one side clears the bar
  assert.equal(eligibleForMovers(2, 6, 100), false); // penny-card noise excluded
  assert.equal(eligibleForMovers(150, -1, 100), false); // missing "then"
  assert.equal(eligibleForMovers(150, null, 100), false);
});

// ---------------------------------------------------------------------------
// Alert crossing logic
// ---------------------------------------------------------------------------

test('ruleCrossed fires only on an actual threshold crossing, in the right direction', () => {
  assert.equal(ruleCrossed({ dir: 'up', cents: 1000 }, 1000, 900), true); // crossed up through 1000
  assert.equal(ruleCrossed({ dir: 'up', cents: 1000 }, 1000, 1100), false); // was already above
  assert.equal(ruleCrossed({ dir: 'down', cents: 1000 }, 900, 1100), true); // crossed down through 1000
  assert.equal(ruleCrossed({ dir: 'down', cents: 1000 }, 1100, 900), false); // was already below
  assert.equal(ruleCrossed({ dir: 'up', cents: 1000 }, 1000, null), false); // can't confirm a crossing
});

// ---------------------------------------------------------------------------
// End-to-end: fixtures -> ingest -> seed -> build-pack, validated against
// the SPEC field order and shape.
// ---------------------------------------------------------------------------

test('end-to-end pipeline produces a SPEC-shaped pack', async (t) => {
  const dir = tmpDir('e2e');
  const fixturesDir = path.join(dir, 'fixtures');
  const historyDir = path.join(dir, 'history');
  const outDir = path.join(dir, 'public-data');

  writeFixtures(fixturesDir);

  await runSeed([
    '--source-prices', path.join(fixturesDir, 'mtgjson-prices.json'),
    '--source-identifiers', path.join(fixturesDir, 'mtgjson-identifiers.json'),
    '--out', historyDir,
  ]);

  await runIngest([
    '--source', path.join(fixturesDir, 'scryfall-default-cards.json'),
    '--day', ANCHOR_DAY,
    '--out', historyDir,
  ]);

  await runBuildPack([
    '--source', path.join(fixturesDir, 'scryfall-default-cards.json'),
    '--history-dir', historyDir,
    '--out', outDir,
    '--min-cents', '50',
    '--bulk-updated-at', '2026-09-02T07:12:33Z',
  ]);

  const meta = JSON.parse(fs.readFileSync(path.join(outDir, 'meta.json'), 'utf8'));
  const cards = JSON.parse(fs.readFileSync(path.join(outDir, 'cards.json'), 'utf8'));
  const trends = JSON.parse(fs.readFileSync(path.join(outDir, 'trends.json'), 'utf8'));
  const seriesBuf = fs.readFileSync(path.join(outDir, 'series.bin'));

  await t.test('cards.json fields match SPEC order exactly', () => {
    assert.deepEqual(cards.fields, [
      'oid', 'n', 'lo', 'loId', 'loF', 'loS', 'hi', 'hiId', 'hiF', 'hiS',
      'np', 'r', 'cid', 't', 'res', 'yr', 'd1', 'd7', 'd30', 'd90', 'row', 'img', 'cn', 'edh',
    ]);
  });

  await t.test('meta.json shape matches SPEC', () => {
    assert.equal(typeof meta.generated_at, 'string');
    assert.equal(meta.scryfall_bulk_updated_at, '2026-09-02T07:12:33Z');
    assert.ok(Array.isArray(meta.days));
    assert.ok(meta.days.length <= 90);
    assert.deepEqual(meta.days, [...meta.days].sort()); // ascending
    assert.equal(meta.days[meta.days.length - 1], ANCHOR_DAY);
    assert.equal(meta.card_count, cards.rows.length);
    assert.equal(meta.min_tracked_cents, 50);
    assert.equal(meta.series.rows, cards.rows.length);
    assert.equal(meta.series.cols, meta.days.length);
    assert.equal(meta.series.bytes_per_value, 4);
    assert.equal(meta.series.row_bytes, meta.series.cols * 4);
    assert.deepEqual(meta.index_windows, [1, 7, 30, 90]);
  });

  await t.test('rows are sorted by lo DESC and row index matches series.bin order', () => {
    const fi = Object.fromEntries(cards.fields.map((f, i) => [f, i]));
    for (let i = 1; i < cards.rows.length; i++) {
      assert.ok(cards.rows[i - 1][fi.lo] >= cards.rows[i][fi.lo], 'not sorted by lo desc');
    }
    cards.rows.forEach((row, i) => assert.equal(row[fi.row], i));
    assert.equal(seriesBuf.length, meta.series.rows * meta.series.row_bytes);
  });

  await t.test('series.bin last column matches cards.json lo for every row', () => {
    const fi = Object.fromEntries(cards.fields.map((f, i) => [f, i]));
    const cols = meta.series.cols;
    for (const row of cards.rows) {
      const r = row[fi.row];
      const off = (r * cols + (cols - 1)) * 4;
      assert.equal(seriesBuf.readInt32LE(off), row[fi.lo]);
    }
  });

  await t.test('a card absent from an older day reads -1 in series and null in that percent window', () => {
    const fi = Object.fromEntries(cards.fields.map((f, i) => [f, i]));
    const foreignOnly = cards.rows.find((r) => r[fi.n] === '電光の旅人');
    assert.ok(foreignOnly, 'expected the Japanese-only fixture card to be tracked');
    assert.equal(foreignOnly[fi.d1], null);
    assert.equal(foreignOnly[fi.d7], null);
    const cols = meta.series.cols;
    const off = (foreignOnly[fi.row] * cols + 0) * 4; // first (oldest) day
    assert.equal(seriesBuf.readInt32LE(off), -1);
  });

  await t.test('trends.json leaderboards respect the movers_min_cents floor', () => {
    assert.equal(trends.movers_min_cents, 100);
    for (const key of ['d1', 'd7', 'd30', 'd90']) {
      for (const list of [trends.windows[key].gainers, trends.windows[key].losers]) {
        assert.ok(list.length <= 200);
        for (const [, , now, then] of list) {
          assert.ok(Math.max(now, then) >= 100, `${key} entry below movers_min_cents floor`);
        }
      }
      // gainers strictly positive, sorted desc; losers strictly negative, sorted asc
      const g = trends.windows[key].gainers.map((e) => e[1]);
      const l = trends.windows[key].losers.map((e) => e[1]);
      assert.ok(g.every((p) => p > 0));
      assert.ok(l.every((p) => p < 0));
      assert.deepEqual(g, [...g].sort((a, b) => b - a));
      assert.deepEqual(l, [...l].sort((a, b) => a - b));
    }
    assert.equal(trends.index.days.length, meta.days.length);
    assert.equal(trends.index.top100.length, meta.days.length);
    assert.equal(trends.index.median.length, meta.days.length);
    assert.equal(trends.index.movers_up[0], 0); // no "previous day" for the first column
    assert.ok(Array.isArray(trends.sets) && trends.sets.length > 0);
  });

  await t.test('the reserved-list outlier card is present with the right rarity/type/reserved flag', () => {
    const fi = Object.fromEntries(cards.fields.map((f, i) => [f, i]));
    const dual = cards.rows.find((r) => r[fi.n] === 'Volcanic Mire');
    assert.ok(dual);
    assert.equal(dual[fi.res], 1);
    assert.equal(dual[fi.hi], 1_200_000); // the $12,000 Alpha printing
    assert.equal(dual[fi.t] & 64, 64); // Land bit set
  });

  await t.test('re-running ingest for the same day overwrites only that day (idempotent)', async () => {
    const before = fs.readFileSync(path.join(historyDir, `${ANCHOR_DAY}.csv`), 'utf8');
    const otherDays = fs.readdirSync(historyDir).filter((f) => f !== `${ANCHOR_DAY}.csv`);
    const otherBefore = otherDays.map((f) => fs.readFileSync(path.join(historyDir, f), 'utf8'));
    await runIngest([
      '--source', path.join(fixturesDir, 'scryfall-default-cards.json'),
      '--day', ANCHOR_DAY,
      '--out', historyDir,
    ]);
    const after = fs.readFileSync(path.join(historyDir, `${ANCHOR_DAY}.csv`), 'utf8');
    assert.equal(after, before);
    const otherAfter = otherDays.map((f) => fs.readFileSync(path.join(historyDir, f), 'utf8'));
    assert.deepEqual(otherAfter, otherBefore);
  });

  await t.test('re-running seed without --force never overwrites existing day files', async () => {
    const someDay = fs.readdirSync(historyDir).find((f) => f !== `${ANCHOR_DAY}.csv`);
    const before = fs.readFileSync(path.join(historyDir, someDay), 'utf8');
    const result = await runSeed([
      '--source-prices', path.join(fixturesDir, 'mtgjson-prices.json'),
      '--source-identifiers', path.join(fixturesDir, 'mtgjson-identifiers.json'),
      '--out', historyDir,
    ]);
    assert.ok(result.skippedExisting > 0);
    const after = fs.readFileSync(path.join(historyDir, someDay), 'utf8');
    assert.equal(after, before);
  });
});
