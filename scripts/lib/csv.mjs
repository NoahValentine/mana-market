// scripts/lib/csv.mjs
//
// Reader/writer for the `history/<day>.csv` snapshot format defined in
// SPEC.md: `oracle_id,lo_cents,lo_printing,lo_finish,hi_cents,hi_printing,hi_finish`.

import fs from 'node:fs';
import readline from 'node:readline';

export const CSV_HEADER = 'oracle_id,lo_cents,lo_printing,lo_finish,hi_cents,hi_printing,hi_finish';

/** One history row: { oracleId, loCents, loPrinting, loFinish, hiCents, hiPrinting, hiFinish } */
export function rowToCsvLine(row) {
  return [
    row.oracleId,
    row.loCents,
    row.loPrinting,
    row.loFinish,
    row.hiCents,
    row.hiPrinting,
    row.hiFinish,
  ].join(',');
}

/** Serialize rows (sorted by oracle_id ascending) to full CSV text, header included. */
export function rowsToCsv(rows) {
  const sorted = [...rows].sort((a, b) =>
    a.oracleId < b.oracleId ? -1 : a.oracleId > b.oracleId ? 1 : 0,
  );
  const lines = [CSV_HEADER, ...sorted.map(rowToCsvLine)];
  return lines.join('\n') + '\n';
}

/** Write rows to `filePath` as CSV (creates parent dir if needed). */
export function writeCsvFile(filePath, rows) {
  fs.mkdirSync(dirnameOf(filePath), { recursive: true });
  fs.writeFileSync(filePath, rowsToCsv(rows));
}

function dirnameOf(filePath) {
  const i = filePath.lastIndexOf('/');
  return i === -1 ? '.' : filePath.slice(0, i);
}

/** Parse CSV text (with header) into an array of row objects. */
export function parseCsv(text) {
  const lines = text.split('\n').filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const [header, ...rest] = lines;
  if (header.trim() !== CSV_HEADER) {
    throw new Error(`unexpected CSV header: ${header}`);
  }
  return rest.map((line) => {
    const [oracleId, loCents, loPrinting, loFinish, hiCents, hiPrinting, hiFinish] =
      line.split(',');
    return {
      oracleId,
      loCents: parseInt(loCents, 10),
      loPrinting,
      loFinish: parseInt(loFinish, 10),
      hiCents: parseInt(hiCents, 10),
      hiPrinting,
      hiFinish: parseInt(hiFinish, 10),
    };
  });
}

/** Read and parse a CSV file synchronously. */
export function readCsvFile(filePath) {
  return parseCsv(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Read a CSV file into a Map<oracle_id, row> for random access. Streams
 * line-by-line so it stays cheap even for a large day file.
 */
export async function readCsvFileAsMap(filePath) {
  const map = new Map();
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, 'utf8'),
    crlfDelay: Infinity,
  });
  let first = true;
  for await (const line of rl) {
    if (line.length === 0) continue;
    if (first) {
      first = false;
      if (line.trim() !== CSV_HEADER) throw new Error(`unexpected CSV header: ${line}`);
      continue;
    }
    const [oracleId, loCents, loPrinting, loFinish, hiCents, hiPrinting, hiFinish] =
      line.split(',');
    map.set(oracleId, {
      oracleId,
      loCents: parseInt(loCents, 10),
      loPrinting,
      loFinish: parseInt(loFinish, 10),
      hiCents: parseInt(hiCents, 10),
      hiPrinting,
      hiFinish: parseInt(hiFinish, 10),
    });
  }
  return map;
}

/** List available `history/<day>.csv` files, returns [{ day, path }] sorted ascending by day. */
export function listHistoryDays(historyDir) {
  if (!fs.existsSync(historyDir)) return [];
  const entries = fs
    .readdirSync(historyDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.csv$/.test(f))
    .map((f) => ({ day: f.slice(0, 10), path: `${historyDir}/${f}` }));
  entries.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return entries;
}
