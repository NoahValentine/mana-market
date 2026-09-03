#!/usr/bin/env node
// scripts/send-alerts.mjs
//
// Runs after a nightly pack build. Reads the just-built public/data pack,
// fetches subscriptions from the Worker, and sends a web-push notification
// for every rule a card crossed today (vs yesterday's cheapest-printing
// price). Dead (404/410) endpoints are reported back to the Worker so it
// can prune its KV store.
//
// Usage:
//   node scripts/send-alerts.mjs [--data-dir public/data] [--site https://example.com]
//     [--subs-source <path-or-url>] [--dry-run]
//
// Env:
//   SITE_URL              base URL of the deployed site/Worker (or --site)
//   ADMIN_TOKEN           sent as X-Admin-Token to /api/subs and /api/sent
//   VAPID_PUBLIC_KEY      \
//   VAPID_PRIVATE_KEY      > web-push VAPID credentials
//   VAPID_SUBJECT         /  (mailto: or https: URL, per the web-push spec)
//
// --dry-run (or missing VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY) prints what
// would be sent instead of calling web-push / the Worker.

import fs from 'node:fs';
import webpush from 'web-push';

function parseArgs(argv) {
  const args = { dataDir: 'public/data' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--data-dir') args.dataDir = argv[++i];
    else if (a === '--site') args.site = argv[++i];
    else if (a === '--subs-source') args.subsSource = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help') args.help = true;
  }
  return args;
}

function loadCardsIndex(dataDir) {
  const cards = JSON.parse(fs.readFileSync(`${dataDir}/cards.json`, 'utf8'));
  const meta = JSON.parse(fs.readFileSync(`${dataDir}/meta.json`, 'utf8'));
  const series = fs.readFileSync(`${dataDir}/series.bin`);
  const cols = meta.series.cols;
  const idx = new Map(); // oid -> { lo, row }
  const fi = Object.fromEntries(cards.fields.map((f, i) => [f, i]));
  for (const row of cards.rows) {
    idx.set(row[fi.oid], { lo: row[fi.lo], row: row[fi.row], name: row[fi.n] });
  }
  function loCentsYesterday(rowIndex) {
    if (cols < 2) return null;
    const offset = (rowIndex * cols + (cols - 2)) * 4;
    const v = series.readInt32LE(offset);
    return v === -1 ? null : v;
  }
  return { idx, loCentsYesterday };
}

/** Parse the NDJSON body of GET /api/subs into an array of subscription objects. */
function parseNdjson(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function loadSubscriptions({ subsSource, site, adminToken, log }) {
  if (subsSource) {
    if (/^https?:\/\//i.test(subsSource)) {
      const res = await fetch(subsSource, { headers: { 'X-Admin-Token': adminToken || '' } });
      if (!res.ok) throw new Error(`subs fetch failed: ${res.status}`);
      return parseNdjson(await res.text());
    }
    return parseNdjson(fs.readFileSync(subsSource, 'utf8'));
  }
  if (!site) throw new Error('--site or SITE_URL is required (or pass --subs-source for a fixture)');
  const res = await fetch(`${site.replace(/\/$/, '')}/api/subs`, {
    headers: { 'X-Admin-Token': adminToken || '' },
  });
  if (!res.ok) throw new Error(`subs fetch failed: ${res.status}`);
  log(`fetched subscriptions from ${site}/api/subs`);
  return parseNdjson(await res.text());
}

/** Does this rule fire, given today's and yesterday's cheapest-printing price? */
export function ruleCrossed(rule, nowCents, thenCents) {
  if (nowCents === undefined || nowCents === null) return false;
  if (thenCents === null || thenCents === undefined) return false; // can't confirm a crossing
  if (rule.dir === 'up') return nowCents >= rule.cents && thenCents < rule.cents;
  if (rule.dir === 'down') return nowCents <= rule.cents && thenCents > rule.cents;
  return false;
}

function buildPayload(rule, nowCents) {
  const dollars = (rule.cents / 100).toFixed(2);
  const dir = rule.dir === 'up' ? 'risen to' : 'dropped to';
  return {
    title: `${rule.name} ${dir} $${dollars}`,
    body: `Now $${(nowCents / 100).toFixed(2)}. Tap to view.`,
    url: `/#/card/${rule.oid}`,
    tag: `${rule.oid}-${rule.dir}-${rule.cents}`,
  };
}

export async function run(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(
      'Usage: node scripts/send-alerts.mjs [--data-dir public/data] [--site url] [--subs-source path|url] [--dry-run]',
    );
    return;
  }

  const site = args.site || process.env.SITE_URL;
  const adminToken = process.env.ADMIN_TOKEN;
  const vapidPublic = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
  const dryRun = args.dryRun || !vapidPublic || !vapidPrivate;

  if (!dryRun) {
    webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
  } else {
    console.log('[dry-run] no VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY (or --dry-run passed) -- printing only');
  }

  const { idx, loCentsYesterday } = loadCardsIndex(args.dataDir);
  const subs = await loadSubscriptions({
    subsSource: args.subsSource,
    site,
    adminToken,
    log: (m) => console.log(m),
  });
  console.log(`Loaded ${subs.length} subscription(s), ${idx.size} tracked card(s).`);

  let sent = 0;
  let skippedNoData = 0;
  let skippedNoCross = 0;
  const dead = [];

  for (const sub of subs) {
    const firing = [];
    for (const rule of sub.rules || []) {
      const card = idx.get(rule.oid);
      if (!card) {
        skippedNoData++;
        continue;
      }
      const then = loCentsYesterday(card.row);
      if (ruleCrossed(rule, card.lo, then)) {
        firing.push(buildPayload({ ...rule, name: rule.name || card.name }, card.lo));
      } else {
        skippedNoCross++;
      }
    }
    if (firing.length === 0) continue;

    for (const payload of firing) {
      if (dryRun) {
        console.log(`[dry-run] would push to ${sub.endpoint.slice(0, 32)}...: ${payload.title}`);
        sent++;
        continue;
      }
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          JSON.stringify(payload),
        );
        sent++;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          dead.push(sub.endpoint);
        } else {
          console.error(`push failed (status ${err.statusCode || 'unknown'})`);
        }
      }
    }
  }

  if (dead.length > 0) {
    if (dryRun) {
      console.log(`[dry-run] would report ${dead.length} dead endpoint(s) to /api/sent`);
    } else if (site) {
      const res = await fetch(`${site.replace(/\/$/, '')}/api/sent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Token': adminToken || '' },
        body: JSON.stringify({ dead }),
      });
      if (!res.ok) console.error(`failed to report dead endpoints: ${res.status}`);
    }
  }

  console.log('');
  console.log('Alerts summary');
  console.log(`  notifications sent:      ${sent}${dryRun ? ' (dry-run)' : ''}`);
  console.log(`  rules skipped (no card): ${skippedNoData}`);
  console.log(`  rules skipped (no crossing): ${skippedNoCross}`);
  console.log(`  dead endpoints: ${dead.length}`);

  return { sent, dead: dead.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
