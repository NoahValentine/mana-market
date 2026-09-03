#!/usr/bin/env node
// Sends price alerts to a phone through ntfy.sh — no server, no account, no keys.
// Runs in CI after `npm run pack`, reading the freshly built pack.
//
//   node scripts/send-ntfy.mjs [--config alerts.json] [--pack public/data] [--dry-run]
//
// alerts.json (repo root, optional):
//   {
//     "ntfy_topic": "mana-market-ab12cd34",
//     "spike_pct": 25,             // alert on any tracked card moving this much in a day
//     "spike_min_dollars": 5,      // ...as long as it is worth at least this much
//     "rules": [                   // your own thresholds, exported from the Watchlist screen
//       { "oid": "...", "name": "Rhystic Study", "dir": "up", "cents": 3000 }
//     ]
//   }
//
// NTFY_TOPIC in the environment overrides the file, so the topic can be kept in
// a GitHub secret instead of the repo if you prefer.

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const CONFIG = flag('--config', 'alerts.json');
const PACK = flag('--pack', path.join('public', 'data'));
const SITE = process.env.SITE_URL || '';
const DRY = args.includes('--dry-run');
const MAX_LINES = 12;

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

const config = readJson(CONFIG, {}) || {};
const topic = (process.env.NTFY_TOPIC || config.ntfy_topic || '').trim();
const spikePct = Number(config.spike_pct ?? 25);
const spikeMinCents = Math.round(Number(config.spike_min_dollars ?? 5) * 100);
const rules = Array.isArray(config.rules) ? config.rules : [];

const cardsFile = path.join(PACK, 'cards.json');
const pack = readJson(cardsFile);
if (!pack?.rows?.length) {
  console.error(`No pack at ${cardsFile} — run "npm run pack" first.`);
  process.exit(1);
}

const idx = {};
pack.fields.forEach((f, i) => { idx[f] = i; });
const cards = pack.rows.map((r) => ({
  oid: r[idx.oid], name: r[idx.n], lo: r[idx.lo], loId: r[idx.loId], set: r[idx.loS],
  d1: r[idx.d1], d7: r[idx.d7],
}));
const byOid = new Map(cards.map((c) => [c.oid, c]));

const dollars = (cents) => `$${(cents / 100).toLocaleString('en-US', {
  minimumFractionDigits: cents < 10000 ? 2 : 0, maximumFractionDigits: cents < 10000 ? 2 : 0,
})}`;
const pct = (v) => `${v > 0 ? '+' : ''}${(v / 100).toFixed(1)}%`;
/** Yesterday's price implied by today's price and the stored 24h percent change. */
const yesterday = (c) => (c.d1 == null ? null : Math.round(c.lo / (1 + c.d1 / 10000)));

// ---- 1. spike alerts (no configuration needed) -----------------------------
const spikes = cards
  .filter((c) => c.d1 != null && c.lo >= spikeMinCents && Math.abs(c.d1) >= spikePct * 100)
  .sort((a, b) => Math.abs(b.d1) - Math.abs(a.d1));

// ---- 2. your own thresholds ------------------------------------------------
const crossed = [];
for (const rule of rules) {
  const c = byOid.get(rule.oid);
  if (!c) continue;
  const then = yesterday(c);
  const cents = Number(rule.cents);
  if (!Number.isFinite(cents)) continue;
  if (rule.dir === 'down') {
    if (c.lo <= cents && (then == null || then > cents)) crossed.push({ rule, c, then });
  } else if (c.lo >= cents && (then == null || then < cents)) {
    crossed.push({ rule, c, then });
  }
}

// ---- send ------------------------------------------------------------------
const messages = [];

if (crossed.length) {
  messages.push({
    title: crossed.length === 1
      ? `${crossed[0].c.name} hit ${dollars(crossed[0].rule.cents)}`
      : `${crossed.length} watchlist alerts`,
    priority: 'default',
    tags: 'bell',
    body: crossed.slice(0, MAX_LINES).map(({ rule, c }) => (
      `${c.name} ${dollars(c.lo)} (${rule.dir === 'up' ? 'above' : 'below'} ${dollars(rule.cents)}, ${pct(c.d1 ?? 0)} today)`
    )).join('\n'),
    click: crossed.length === 1 ? `${SITE}/#/card/${crossed[0].c.loId}` : `${SITE}/#/watchlist`,
  });
}

if (spikes.length) {
  const up = spikes.filter((c) => c.d1 > 0).length;
  messages.push({
    title: `${spikes.length} card${spikes.length === 1 ? '' : 's'} moved over ${spikePct}% (${up} up)`,
    priority: 'low',
    tags: 'chart_with_upwards_trend',
    body: spikes.slice(0, MAX_LINES).map((c) => (
      `${c.d1 > 0 ? '▲' : '▼'} ${c.name} ${dollars(c.lo)} ${pct(c.d1)}`
    )).join('\n') + (spikes.length > MAX_LINES ? `\n…and ${spikes.length - MAX_LINES} more` : ''),
    click: `${SITE}/#/trends`,
  });
}

if (!messages.length) {
  console.log('Nothing to alert: no threshold crossings and no spikes today.');
  process.exit(0);
}

if (!topic) {
  console.log(`No ntfy topic configured (set ntfy_topic in ${CONFIG} or NTFY_TOPIC), would have sent:`);
  messages.forEach((m) => console.log(`\n--- ${m.title}\n${m.body}`));
  process.exit(0);
}

if (DRY) {
  console.log(`Dry run for topic ${topic}:`);
  messages.forEach((m) => console.log(`\n--- ${m.title}\n${m.body}`));
  process.exit(0);
}

let failed = 0;
for (const m of messages) {
  const headers = {
    Title: m.title,
    Priority: m.priority,
    Tags: m.tags,
    'Content-Type': 'text/plain; charset=utf-8',
  };
  if (m.click && SITE) headers.Click = m.click;
  try {
    const res = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST', headers, body: m.body,
    });
    if (!res.ok) {
      failed += 1;
      console.error(`ntfy returned HTTP ${res.status} for "${m.title}"`);
    } else {
      console.log(`sent: ${m.title}`);
    }
  } catch (err) {
    failed += 1;
    console.error(`ntfy request failed: ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);
