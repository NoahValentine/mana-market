// Builds a LARGER, demo-only market pack so screenshots show a realistic
// screenful of cards. Card names are real; the prices and history are
// synthetic (a seeded random walk) — this pack is for screenshots and local
// UI work only, and the nightly job overwrites it with real Scryfall data.
//
// Usage: node test/make-demo-pack.mjs [--out public/data] [--days 90]
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'public/data';
const DAYS = args.includes('--days') ? Number(args[args.indexOf('--days') + 1]) : 90;
const TODAY = new Date();

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(4242);

// name, cheapest-printing dollars, set, rarity(0-4), colour identity, type mask, reserved, year, printings
const SEED = [
  ['Black Lotus', 21500, 'lea', 4, '', 8, 1, 1993, 6],
  ['Ancestral Recall', 9200, 'lea', 4, 'U', 2, 1, 1993, 5],
  ['Time Walk', 5400, 'lea', 4, 'U', 4, 1, 1993, 5],
  ['Mox Sapphire', 4800, 'lea', 4, '', 8, 1, 1993, 5],
  ['Mox Jet', 4600, 'lea', 4, '', 8, 1, 1993, 5],
  ['Mox Ruby', 4100, 'lea', 4, '', 8, 1, 1993, 5],
  ['Mox Pearl', 3600, 'lea', 4, '', 8, 1, 1993, 5],
  ['Mox Emerald', 3400, 'lea', 4, '', 8, 1, 1993, 5],
  ['Timetwister', 3100, 'lea', 4, 'U', 4, 1, 1993, 5],
  ['The Tabernacle at Pendrell Vale', 2650, 'leg', 4, '', 64, 1, 1994, 3],
  ['Underground Sea', 480, 'rev', 2, 'UB', 64, 1, 1993, 7],
  ['Volcanic Island', 430, 'rev', 2, 'UR', 64, 1, 1993, 7],
  ['Bazaar of Baghdad', 1650, 'arn', 4, '', 64, 1, 1993, 4],
  ['Library of Alexandria', 890, 'arn', 4, '', 64, 1, 1993, 4],
  ['Gaea’s Cradle', 620, 'usg', 2, '', 64, 1, 1998, 3],
  ['Mishra’s Workshop', 1450, 'atq', 4, '', 64, 1, 1994, 3],
  ['Imperial Seal', 320, 'ptk', 2, 'B', 4, 1, 1999, 4],
  ['Mana Crypt', 78, 'ema', 3, '', 8, 0, 1994, 9],
  ['Mana Drain', 42, 'lgn', 2, 'U', 2, 0, 1994, 8],
  ['Force of Will', 58, 'all', 1, 'U', 2, 0, 1996, 12],
  ['Rhystic Study', 21, 'pcy', 1, 'U', 16, 0, 2000, 11],
  ['Smothering Tithe', 24, 'rna', 2, 'W', 16, 0, 2019, 7],
  ['Dockside Extortionist', 46, 'c19', 2, 'R', 1, 0, 2019, 4],
  ['Jeweled Lotus', 32, 'cmr', 3, '', 8, 0, 2020, 5],
  ['The One Ring', 38, 'ltr', 3, '', 8 + 256, 0, 2023, 6],
  ['Orcish Bowmasters', 34, 'ltr', 3, 'B', 1 + 256, 0, 2023, 5],
  ['Sheoldred, the Apocalypse', 52, 'dmu', 3, 'B', 1 + 256, 0, 2022, 6],
  ['Ragavan, Nimble Pilferer', 44, 'mh2', 3, 'R', 1 + 256, 0, 2021, 7],
  ['Wrenn and Six', 28, 'mh1', 3, 'RG', 32 + 256, 0, 2019, 4],
  ['Urza, Lord High Artificer', 18, 'mh1', 3, 'U', 1 + 256, 0, 2019, 5],
  ['Grim Monolith', 74, 'usg', 2, '', 8, 1, 1998, 3],
  ['Lion’s Eye Diamond', 96, 'mir', 2, '', 8, 1, 1996, 4],
  ['Candelabra of Tawnos', 380, 'atq', 4, '', 8, 1, 1994, 3],
  ['Chains of Mephistopheles', 210, 'leg', 4, 'B', 16, 1, 1994, 2],
  ['Moat', 175, 'leg', 4, 'W', 16, 1, 1994, 3],
  ['Nether Void', 130, 'leg', 4, 'B', 16, 1, 1994, 2],
  ['City of Traitors', 34, 'exo', 2, '', 64, 0, 1998, 6],
  ['Ancient Tomb', 22, 'tmp', 1, '', 64, 0, 1997, 9],
  ['Cavern of Souls', 26, 'avr', 2, '', 64, 0, 2012, 6],
  ['Cyclonic Rift', 14, 'rtr', 2, 'U', 2, 0, 2012, 8],
  ['Craterhoof Behemoth', 12, 'avr', 3, 'G', 1 + 256, 0, 2012, 9],
  ['Demonic Tutor', 9, 'lea', 1, 'B', 4, 0, 1993, 14],
  ['Cyclonic Rift (foil)', 34, 'rtr', 2, 'U', 2, 0, 2012, 8],
  ['Vampiric Tutor', 8, 'vis', 2, 'B', 2, 0, 1997, 11],
  ['Fierce Guardianship', 26, 'znr', 2, 'U', 2, 0, 2019, 5],
  ['Deflecting Swat', 15, 'c20', 2, 'R', 2, 0, 2020, 4],
  ['Teferi’s Protection', 18, 'c17', 2, 'W', 2, 0, 2017, 6],
  ['Ancient Copper Dragon', 21, 'clb', 3, 'R', 1 + 256, 0, 2022, 3],
  ['Esper Sentinel', 22, 'mh2', 2, 'W', 1, 0, 2021, 5],
  ['Solitude', 42, 'mh2', 3, 'W', 1 + 256, 0, 2021, 4],
  ['Grief', 26, 'mh2', 3, 'B', 1, 0, 2021, 4],
  ['Fury', 38, 'mh2', 3, 'R', 1, 0, 2021, 4],
  ['Underworld Breach', 12, 'thb', 2, 'R', 16, 0, 2020, 5],
  ['Aetherflux Reservoir', 15, 'kld', 3, '', 8, 0, 2016, 6],
  ['Bolas’s Citadel', 11, 'war', 2, 'B', 8 + 256, 0, 2019, 4],
  ['Consecrated Sphinx', 16, 'mbs', 3, 'U', 1, 0, 2011, 7],
  ['Toxic Deluge', 13, 'cns', 2, 'B', 4, 0, 2014, 6],
  ['Chrome Mox', 24, 'mrd', 2, '', 8, 0, 2003, 7],
  ['Force of Negation', 12, 'mh1', 2, 'U', 2, 0, 2019, 4],
  ['Sylvan Library', 27, 'lgn', 2, 'G', 16, 0, 1994, 8],
  ['Sensei’s Divining Top', 11, 'chk', 1, '', 8, 0, 2004, 7],
  ['Phyrexian Altar', 22, 'inv', 2, '', 8, 0, 2000, 5],
  ['Ashnod’s Altar', 6, 'atq', 1, '', 8, 0, 1994, 12],
  ['Blood Artist', 4, 'avr', 1, 'B', 1 + 256, 0, 2012, 11],
  ['Sol Ring', 2, 'c21', 1, '', 8, 0, 1993, 42],
  ['Arcane Signet', 1, 'eld', 1, '', 8, 0, 2019, 38],
  ['Cultivate', 1, 'm11', 1, 'G', 4, 0, 2010, 27],
  ['Swords to Plowshares', 2, 'lea', 1, 'W', 2, 0, 1993, 33],
  ['Counterspell', 1, 'lea', 1, 'U', 2, 0, 1993, 40],
  ['Lightning Bolt', 2, 'lea', 1, 'R', 2, 0, 1993, 36],
  ['Path to Exile', 3, 'con', 1, 'W', 2, 0, 2009, 18],
  ['Beast Within', 3, 'nph', 1, 'G', 2, 0, 2011, 16],
  ['Ghostly Prison', 4, 'chk', 1, 'W', 16, 0, 2004, 14],
  ['Kindred Discovery', 9, 'c17', 2, 'U', 16, 0, 2017, 5],
  ['Bloom Tender', 24, 'eve', 2, 'G', 1, 0, 2008, 4],
  ['Nether Traitor', 8, 'gpt', 2, 'B', 1, 0, 2006, 5],
  ['Doubling Season', 34, 'rav', 2, 'G', 16, 0, 2005, 8],
  ['Parallel Lives', 17, 'isd', 2, 'G', 16, 0, 2011, 5],
  ['Anointed Procession', 22, 'akh', 2, 'W', 16, 0, 2017, 4],
  ['Seedborn Muse', 12, 'lgn', 2, 'G', 1, 0, 2003, 9],
  ['Deadly Rollick', 8, 'c20', 2, 'B', 2, 0, 2020, 4],
  ['Ancient Greenwarden', 7, 'znr', 3, 'G', 1, 0, 2020, 4],
  ['Nyxbloom Ancient', 9, 'thb', 3, 'G', 1, 0, 2020, 4],
  ['Ulamog, the Ceaseless Hunger', 8, 'bfz', 3, '', 1 + 256, 0, 2015, 7],
  ['Emrakul, the Promised End', 12, 'emn', 3, '', 1 + 256, 0, 2016, 5],
  ['Kozilek, Butcher of Truth', 26, 'roe', 3, '', 1 + 256, 0, 2010, 4],
  ['Void Winnower', 9, 'bfz', 3, '', 1, 0, 2015, 4],
  ['Thassa’s Oracle', 5, 'thb', 1, 'U', 1, 0, 2020, 5],
  ['Demonic Consultation', 6, 'ice', 1, 'B', 2, 0, 1995, 5],
  ['Tainted Pact', 11, 'ody', 2, 'B', 2, 0, 2002, 5],
  ['Lotus Petal', 8, 'tmp', 1, '', 8, 0, 1997, 8],
  ['Mystic Remora', 6, 'ice', 1, 'U', 16, 0, 1995, 5],
  ['Talisman of Dominance', 3, 'apc', 1, '', 8, 0, 2001, 9],
  ['Fetid Pools', 1, 'akh', 1, 'UB', 64, 0, 2017, 5],
  ['Command Tower', 1, 'cmd', 1, '', 64, 0, 2011, 31],
  ['Reliquary Tower', 1, 'cnf', 1, '', 64, 0, 2010, 22],
  ['Wasteland', 42, 'tmp', 1, '', 64, 0, 1997, 8],
  ['Chalice of the Void', 34, 'mrd', 2, '', 8, 0, 2003, 7],
  ['Blood Moon', 21, 'chr', 2, 'R', 16, 0, 1995, 9],
  ['Karn Liberated', 22, 'nph', 3, '', 32 + 256, 0, 2011, 6],
  ['Ugin, the Spirit Dragon', 24, 'frf', 3, '', 32 + 256, 0, 2015, 7],
  ['Liliana of the Veil', 26, 'isd', 3, 'B', 32 + 256, 0, 2011, 6],
  ['Jace, the Mind Sculptor', 28, 'wwk', 3, 'U', 32 + 256, 0, 2010, 6],
];

const FINISHES = [0, 0, 0, 1, 1, 2];
const days = Array.from({ length: DAYS }, (_, i) => {
  const d = new Date(TODAY);
  d.setUTCDate(d.getUTCDate() - (DAYS - 1 - i));
  return d.toISOString().slice(0, 10);
});

const cards = SEED.map((s, i) => {
  const [name, dollars, set, rarity, cid, types, reserved, year, np] = s;
  const nowCents = Math.round(dollars * 100);
  // random walk backwards from today with an occasional spike
  const series = new Array(DAYS);
  series[DAYS - 1] = nowCents;
  let drift = (rnd() - 0.5) * 0.0025;
  let last = nowCents;
  for (let d = DAYS - 2; d >= 0; d -= 1) {
    const shock = rnd() < 0.015 ? (rnd() - 0.5) * 0.08 : 0;
    const step = 1 + drift + (rnd() - 0.5) * 0.008 + shock;
    // keep the whole walk within +-45% of today so the demo looks like a real
    // market rather than a lottery ticket
    last = Math.min(nowCents * 1.45, Math.max(nowCents * 0.55, Math.round(last / step)));
    series[d] = Math.max(25, last);
    if (rnd() < 0.02) drift = (rnd() - 0.5) * 0.003;
    if (rnd() < 0.03) series[d] = -1;             // a missing snapshot day
  }
  const hiMult = 1.6 + rnd() * 9;
  const id = (p) => `${p}${String(i).padStart(4, '0')}-demo-4000-8000-${p}${String(i).padStart(6, '0')}`;
  const pct = (backDays) => {
    const then = series[DAYS - 1 - backDays];
    if (then == null || then <= 0) return null;
    return Math.round(((nowCents - then) / then) * 10000);
  };
  const a = String.fromCharCode(97 + (i % 26));
  const b = String.fromCharCode(97 + ((i * 7) % 26));
  return {
    oid: `demo-oracle-${String(i).padStart(4, '0')}`,
    n: name, lo: nowCents, loId: id('lo'), loF: FINISHES[i % FINISHES.length], loS: set,
    hi: Math.round(nowCents * hiMult), hiId: id('hi'), hiF: (i % 3), hiS: ['sld', 'ltr', '2xm', 'plst'][i % 4],
    np, r: rarity, cid, t: types, res: reserved, yr: year,
    d1: pct(1), d7: pct(7), d30: pct(30), d90: pct(DAYS - 1),
    img: `front/${a}/${b}/${id('lo')}.jpg?1700000000`,
    cn: String(10 + (i * 3) % 300), edh: 1 + ((i * 37) % 900),
    series,
  };
}).sort((x, y) => y.lo - x.lo);

cards.forEach((c, i) => { c.row = i; });

const fields = ['oid', 'n', 'lo', 'loId', 'loF', 'loS', 'hi', 'hiId', 'hiF', 'hiS', 'np', 'r', 'cid', 't', 'res', 'yr', 'd1', 'd7', 'd30', 'd90', 'row', 'img', 'cn', 'edh'];
const rows = cards.map((c) => fields.map((f) => c[f]));

const buf = Buffer.alloc(cards.length * DAYS * 4);
cards.forEach((c, i) => {
  c.series.forEach((v, d) => buf.writeInt32LE(v ?? -1, (i * DAYS + d) * 4));
});

const eligible = (now, then) => Math.max(now, then) >= 100;
function leaderboard(backDays) {
  const scored = [];
  for (const c of cards) {
    const then = c.series[DAYS - 1 - backDays];
    if (then == null || then <= 0) continue;
    if (!eligible(c.lo, then)) continue;
    scored.push([c.oid, Math.round(((c.lo - then) / then) * 10000), c.lo, then]);
  }
  const gainers = scored.filter((s) => s[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 200);
  const losers = scored.filter((s) => s[1] < 0).sort((a, b) => a[1] - b[1]).slice(0, 200);
  return { gainers, losers };
}

// carry-forward view of each series so a missing day does not dent the index
const filledOf = new Map();
const filled = (c) => {
  let a = filledOf.get(c);
  if (a) return a;
  a = new Array(DAYS);
  let last = -1;
  for (let d = 0; d < DAYS; d += 1) { if (c.series[d] > 0) last = c.series[d]; a[d] = last; }
  const first = a.find((v) => v > 0) ?? 0;
  for (let d = 0; d < DAYS && a[d] <= 0; d += 1) a[d] = first;
  filledOf.set(c, a);
  return a;
};
const valueOn = (d, n) => cards.slice(0, n).reduce((a, c) => a + Math.max(0, filled(c)[d]), 0);
const medianOn = (d) => {
  const v = cards.map((c) => filled(c)[d]).filter((x) => x > 0).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : 0;
};
const moversOn = (d, up) => cards.filter((c) => {
  const a = filled(c)[d - 1]; const b = filled(c)[d];
  if (!(a > 0 && b > 0)) return false;
  const p = (b - a) / a;
  return up ? p > 0.05 : p < -0.05;
}).length;

const trends = {
  generated_at: new Date().toISOString(),
  windows: { d1: leaderboard(1), d7: leaderboard(7), d30: leaderboard(30), d90: leaderboard(DAYS - 1) },
  movers_min_cents: 100,
  index: {
    days,
    top100: days.map((_, d) => valueOn(d, 100)),
    top1000: days.map((_, d) => valueOn(d, cards.length)),
    median: days.map((_, d) => medianOn(d)),
    movers_up: days.map((_, d) => (d ? moversOn(d, true) : 0)),
    movers_down: days.map((_, d) => (d ? moversOn(d, false) : 0)),
  },
  sets: Object.entries(cards.reduce((acc, c) => {
    acc[c.loS] = (acc[c.loS] || 0) + c.lo;
    return acc;
  }, {})).map(([code, total]) => ({
    code, name: `Demo set ${code.toUpperCase()}`, total, d7: Math.round((rnd() - 0.4) * 1500),
  })).sort((a, b) => b.total - a.total),
};

const meta = {
  generated_at: new Date().toISOString(),
  scryfall_bulk_updated_at: new Date().toISOString(),
  days,
  card_count: cards.length,
  min_tracked_cents: 50,
  series: { rows: cards.length, cols: DAYS, bytes_per_value: 4, row_bytes: DAYS * 4 },
  index_windows: [1, 7, 30, 90],
  demo: true,
};

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'cards.json'), JSON.stringify({ fields, rows }));
fs.writeFileSync(path.join(out, 'series.bin'), buf);
fs.writeFileSync(path.join(out, 'trends.json'), JSON.stringify(trends));
fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify(meta));
console.log(`demo pack: ${cards.length} cards, ${DAYS} days -> ${out}`);
