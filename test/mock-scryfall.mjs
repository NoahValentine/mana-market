// Playwright route handlers that stand in for api.scryfall.com and the image CDN.
// The sandbox cannot reach Scryfall, so UI tests run against the same synthetic
// bulk fixture the pipeline tests use.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BULK = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'fixtures', 'scryfall-default-cards.json'), 'utf8'));
const CARD_IMG = fs.readFileSync(path.join(HERE, 'card-placeholder.jpg'));

const cents = (c) => (c.prices?.usd ? parseFloat(c.prices.usd) : c.prices?.usd_foil ? parseFloat(c.prices.usd_foil) : 0);
const paper = BULK.filter((c) => (c.games || []).includes('paper'));

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

function searchResponse(url) {
  const q = url.searchParams.get('q') || '';
  const dir = url.searchParams.get('dir') || 'desc';
  const unique = url.searchParams.get('unique') || 'cards';
  let data = paper.slice();

  const oracle = /oracleid:([\w-]+)/.exec(q);
  if (oracle) data = data.filter((c) => c.oracle_id === oracle[1]);
  const set = /\bset:(\w+)/.exec(q);
  if (set) data = data.filter((c) => c.set === set[1].toLowerCase());
  const min = /usd>=([\d.]+)/.exec(q);
  if (min) data = data.filter((c) => cents(c) >= Number(min[1]));
  const max = /usd<=([\d.]+)/.exec(q);
  if (max) data = data.filter((c) => cents(c) <= Number(max[1]));
  if (/is:reserved/.test(q)) data = data.filter((c) => c.reserved);
  if (/r:mythic/.test(q)) data = data.filter((c) => c.rarity === 'mythic');
  if (/-is:digital/.test(q)) data = data.filter((c) => !c.digital);

  const plain = q.replace(/[\w-]+[:<>=]+[^\s]+/g, '').trim();
  if (plain) data = data.filter((c) => c.name.toLowerCase().includes(plain.toLowerCase()));

  if (unique === 'cards') {
    const seen = new Set();
    data = data.filter((c) => (seen.has(c.oracle_id) ? false : seen.add(c.oracle_id)));
  }
  data.sort((a, b) => (dir === 'asc' ? cents(a) - cents(b) : cents(b) - cents(a)));

  if (!data.length) {
    return { status: 404, body: { object: 'error', code: 'not_found', details: 'Your query did not match any cards.' } };
  }
  return { status: 200, body: { object: 'list', total_cards: data.length, has_more: false, data: data.slice(0, 175) } };
}

export async function installMocks(page) {
  await page.route('https://api.scryfall.com/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;

    if (p === '/cards/search') {
      const r = searchResponse(url);
      return json(route, r.body, r.status);
    }
    if (p === '/cards/collection') {
      const body = JSON.parse(route.request().postData() || '{}');
      const names = (body.identifiers || []).map((i) => (i.name || '').toLowerCase());
      const data = paper.filter((c) => names.includes(c.name.toLowerCase()));
      const found = new Set(data.map((c) => c.name.toLowerCase()));
      return json(route, { object: 'list', data, not_found: names.filter((n) => !found.has(n)).map((name) => ({ name })) });
    }
    const rulings = /^\/cards\/([^/]+)\/rulings$/.exec(p);
    if (rulings) {
      return json(route, { object: 'list', data: [{ published_at: '2019-08-23', comment: 'Fixture ruling: this card works exactly as printed.' }] });
    }
    const one = /^\/cards\/([^/]+)$/.exec(p);
    if (one) {
      const id = decodeURIComponent(one[1]);
      const card = paper.find((c) => c.id === id) || paper[0];
      return json(route, card);
    }
    return json(route, { object: 'error', details: `mock has no route for ${p}` }, 404);
  });

  await page.route('https://cards.scryfall.io/**', (route) => route.fulfill({
    status: 200, contentType: 'image/jpeg', body: CARD_IMG,
  }));
}

export const fixtureCards = paper;
