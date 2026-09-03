// The nightly job broke once because Scryfall renamed the field holding the
// bulk file's URL. These lock in the shape-based fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pickDownloadUrl, isGzipFile, streamCardArray } from '../scripts/lib/scryfall.mjs';

const SELF = 'https://api.scryfall.com/bulk-data/27bf3214-1271-490b-bdfe-c0be6c23d02e';
const FILE = 'https://data.scryfall.io/default-cards/default-cards-20260903090412.json';

test('pickDownloadUrl takes the documented field when it is there', () => {
  assert.equal(pickDownloadUrl({ uri: SELF, download_uri: FILE }), FILE);
});

test('pickDownloadUrl survives a rename to download_url', () => {
  assert.equal(pickDownloadUrl({ uri: SELF, download_url: FILE }), FILE);
});

test('pickDownloadUrl finds a data-host URL under an unknown field name', () => {
  assert.equal(pickDownloadUrl({ uri: SELF, some_new_name: FILE }), FILE);
});

test('pickDownloadUrl never returns the object own API self-link', () => {
  assert.equal(pickDownloadUrl({ uri: SELF, updated_at: '2026-09-03' }), null);
  assert.equal(pickDownloadUrl({ uri: SELF, related_uri: 'https://api.scryfall.com/cards/x' }), null);
});

test('pickDownloadUrl accepts a gzipped file on another host', () => {
  const gz = 'https://cdn.example.com/default-cards.json.gz';
  assert.equal(pickDownloadUrl({ uri: SELF, blob: gz }), gz);
});

test('pickDownloadUrl copes with junk input', () => {
  assert.equal(pickDownloadUrl(null), null);
  assert.equal(pickDownloadUrl({}), null);
  assert.equal(pickDownloadUrl({ download_uri: 42 }), null);
  assert.equal(pickDownloadUrl({ download_uri: 'not-a-url' }), null);
});

test('compression is detected from the bytes, not the file name', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-gz-'));
  const cards = [{ name: 'A' }, { name: 'B' }];
  const plain = path.join(dir, 'cards.json');
  const gzipped = path.join(dir, 'cards-no-extension');   // gzip content, misleading name
  fs.writeFileSync(plain, JSON.stringify(cards));
  fs.writeFileSync(gzipped, zlib.gzipSync(JSON.stringify(cards)));

  assert.equal(isGzipFile(plain), false);
  assert.equal(isGzipFile(gzipped), true);

  for (const file of [plain, gzipped]) {
    const seen = [];
    await streamCardArray(file, (c) => seen.push(c.name));
    assert.deepEqual(seen, ['A', 'B'], `failed for ${path.basename(file)}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
