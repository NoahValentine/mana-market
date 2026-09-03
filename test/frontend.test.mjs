// Unit tests for the browser-side pure functions that do not need a DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQuery, printingPrices, faceOf, hasBack } from '../public/js/scryfall.js';

test('buildQuery always scopes to paper and excludes digital', () => {
  const q = buildQuery({ text: '', min: null, max: null, basis: 'lo' });
  assert.match(q, /game:paper/);
  assert.match(q, /-is:digital/);
  assert.match(q, /prefer:usd-low/);
});

test('buildQuery turns a dollar range into Scryfall usd bounds', () => {
  const q = buildQuery({ text: 't:dragon', min: 25, max: 400, basis: 'lo' });
  assert.match(q, /t:dragon/);
  assert.match(q, /usd>=25/);
  assert.match(q, /usd<=400/);
});

test('buildQuery omits a missing bound', () => {
  assert.match(buildQuery({ min: 500, max: null }), /usd>=500/);
  assert.doesNotMatch(buildQuery({ min: 500, max: null }), /usd<=/);
  assert.doesNotMatch(buildQuery({ min: null, max: 10 }), /usd>=/);
});

test('buildQuery switches the printing preference with the price basis', () => {
  assert.match(buildQuery({ basis: 'hi' }), /prefer:usd-high/);
  assert.match(buildQuery({ basis: 'lo' }), /prefer:usd-low/);
});

test('buildQuery does not fight a user who typed their own operators', () => {
  const q = buildQuery({ text: 'usd>100 game:mtgo prefer:oldest', min: 5, max: 6 });
  assert.doesNotMatch(q, /usd>=5/);
  assert.doesNotMatch(q, /game:paper/);
  assert.doesNotMatch(q, /prefer:usd-low/);
});

test('buildQuery never sends an empty query', () => {
  assert.ok(buildQuery({}).trim().length > 0);
  assert.match(buildQuery({}), /usd>=0\.01/);
});

test('buildQuery respects the extras toggle', () => {
  assert.doesNotMatch(buildQuery({ extras: true }), /-is:digital/);
});

test('printingPrices reads every finish and sorts cheapest first', () => {
  const card = { prices: { usd: '12.50', usd_foil: '4.99', usd_etched: null } };
  const out = printingPrices(card);
  assert.deepEqual(out, [{ finish: 'foil', cents: 499 }, { finish: 'nonfoil', cents: 1250 }]);
});

test('printingPrices copes with a card that has no prices at all', () => {
  assert.deepEqual(printingPrices({ prices: {} }), []);
  assert.deepEqual(printingPrices({}), []);
});

test('printingPrices rounds to whole cents', () => {
  assert.deepEqual(printingPrices({ prices: { usd: '0.005' } }), [{ finish: 'nonfoil', cents: 1 }]);
  assert.deepEqual(printingPrices({ prices: { usd: '1999.99' } }), [{ finish: 'nonfoil', cents: 199999 }]);
});

test('faceOf and hasBack handle single, split and double-faced layouts', () => {
  const single = { name: 'Sol Ring', image_uris: { normal: 'a' } };
  assert.equal(faceOf(single).name, 'Sol Ring');
  assert.equal(hasBack(single), false);

  const dfc = {
    name: 'Delver of Secrets // Insectile Aberration',
    card_faces: [{ name: 'Delver of Secrets', image_uris: { normal: 'front' } },
      { name: 'Insectile Aberration', image_uris: { normal: 'back' } }],
  };
  assert.equal(faceOf(dfc, 1).name, 'Insectile Aberration');
  assert.equal(hasBack(dfc), true);

  // split cards carry one image on the card itself
  const split = { name: 'Fire // Ice', image_uris: { normal: 'both' }, card_faces: [{ name: 'Fire' }, { name: 'Ice' }] };
  assert.equal(hasBack(split), false);
  assert.equal(faceOf(split, 1).name, 'Ice');
});
