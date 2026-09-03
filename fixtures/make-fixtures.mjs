#!/usr/bin/env node
// fixtures/make-fixtures.mjs
//
// Synthesizes realistic-shaped Scryfall bulk-data and MTGJSON fixtures so
// the whole ingest -> seed -> build-pack chain can be exercised locally
// without network access to api.scryfall.com / mtgjson.com (both blocked
// in this sandbox). Deterministic (seeded PRNG) so fixture output -- and
// anything asserted against it in test/pipeline.test.mjs -- is stable
// across runs.
//
// Writes:
//   fixtures/scryfall-default-cards.json   (~900 printing records, ~230-250 oracle cards)
//   fixtures/mtgjson-identifiers.json      (uuid -> scryfall ids)
//   fixtures/mtgjson-prices.json           (95 days of TCGplayer retail, with
//                                            deliberate spikes/drops/trends
//                                            for a handful of cards)
//
// Usage: node fixtures/make-fixtures.mjs [--out fixtures/]

import fs from 'node:fs';
import path from 'node:path';

// The fixture chain treats this as "today" for ingest, independent of the
// real wall clock, so the whole pipeline (and its tests) stay deterministic.
export const ANCHOR_DAY = '2026-09-02';
export const MTGJSON_DAYS = 95; // days of MTGJSON seed history, ending the day before ANCHOR_DAY

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260902);

function pick(arr) {
  return arr[Math.floor(rand() * arr.length)];
}

function isoDaysBack(dayStr, n) {
  const d = new Date(`${dayStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function uuidLike(seedStr) {
  // Not a real UUID -- just a stable, unique-looking id derived from a name.
  let h = 0;
  for (let i = 0; i < seedStr.length; i++) h = (Math.imul(h, 31) + seedStr.charCodeAt(i)) | 0;
  const hex = (h >>> 0).toString(16).padStart(8, '0');
  return `${hex}-0000-4000-8000-${seedStr
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
    .padEnd(12, '0')
    .slice(0, 12)}`;
}

function imageUrl(printingId) {
  const a = printingId.slice(0, 1);
  const b = printingId.slice(1, 2);
  return `https://cards.scryfall.io/normal/front/${a}/${b}/${printingId}.jpg?162${printingId.slice(0, 6)}`;
}

let cards = []; // flattened Scryfall printing records

function addPrintings(def) {
  const oracleId = uuidLike(`oracle-${def.name}`);
  for (const p of def.printings) {
    const id = uuidLike(`print-${def.name}-${p.set}-${p.lang || 'en'}-${p.collector_number}`);
    const record = {
      id,
      oracle_id: oracleId,
      name: def.name,
      lang: p.lang || 'en',
      set: p.set,
      set_name: p.setName,
      set_type: p.setType || 'expansion',
      collector_number: String(p.collector_number),
      released_at: p.releasedAt,
      rarity: p.rarity || 'common',
      layout: def.layout || p.layout || 'normal',
      digital: p.digital || false,
      oversized: p.oversized || false,
      reserved: def.reserved || false,
      games: p.games || ['paper'],
      color_identity: def.colorIdentity || [],
      edhrec_rank: p.edhrecRank ?? def.edhrecRank ?? 0,
      prices: p.prices,
    };
    if (def.cardFaces) {
      record.card_faces = def.cardFaces;
      if (def.topLevelTypeLine !== false) record.type_line = def.typeLine;
      // else: omit top-level type_line/image_uris to exercise the
      // card_faces[0] fallback path in scryfall.mjs
      if (!record.image_uris && def.topLevelTypeLine !== false) {
        record.image_uris = { normal: imageUrl(id) };
      }
    } else {
      record.type_line = def.typeLine;
      record.image_uris = { normal: imageUrl(id) };
    }
    cards.push(record);
  }
}

// ---------------------------------------------------------------------------
// 1) Procedurally generated staple cards: ~220 distinct oracle ids, each
//    reprinted 2-6 times across a 16-set pool spanning 1993-2026, so the
//    bulk fixture totals roughly ~900 printing records with a realistic
//    long-tailed price distribution once combined with the hand-authored
//    vintage chase cards and edge cases below.
// ---------------------------------------------------------------------------

// Older sets get a higher "scarcity" multiplier (smaller original print
// runs -> pricier today), same pattern as the hand-authored Volcanic Mire
// below: a card's cheapest printing is usually its most recent reprint,
// its most expensive is usually its oldest.
const SET_POOL = [
  { code: 'lea', name: 'Limited Edition Alpha', year: 1993, scarcity: 60 },
  { code: 'leb', name: 'Limited Edition Beta', year: 1994, scarcity: 45 },
  { code: '4ed', name: 'Fourth Edition', year: 1995, scarcity: 20 },
  { code: 'tmp', name: 'Tempest', year: 1997, scarcity: 12 },
  { code: 'usg', name: "Urza's Saga", year: 1999, scarcity: 9 },
  { code: 'inv', name: 'Invasion', year: 2000, scarcity: 7 },
  { code: 'scg', name: 'Scourge', year: 2003, scarcity: 5.5 },
  { code: 'rav', name: 'Ravnica: City of Guilds', year: 2005, scarcity: 4.2 },
  { code: 'm10', name: 'Magic 2010', year: 2009, scarcity: 3 },
  { code: 'isd', name: 'Innistrad', year: 2012, scarcity: 2.4 },
  { code: 'ktk', name: 'Khans of Tarkir', year: 2014, scarcity: 1.9 },
  { code: 'akh', name: 'Amonkhet', year: 2017, scarcity: 1.5 },
  { code: 'eld', name: 'Throne of Eldraine', year: 2019, scarcity: 1.25 },
  { code: 'neo', name: 'Kamigawa: Neon Dynasty', year: 2022, scarcity: 1.05 },
  { code: 'mkm', name: 'Murders at Karlov Manor', year: 2024, scarcity: 0.92 },
  { code: 'sho', name: 'Shadows of the Horizon', year: 2026, scarcity: 0.8 },
];

// Name-generation word lists, combined per card "kind" for plausible but
// synthetic Magic-style names. Combinatorics comfortably exceed the ~220
// cards we generate, and generateUniqueName() dedupes with a Set anyway.
const ADJ = [
  'Ashen', 'Verdant', 'Gloomveil', 'Sunlit', 'Cinder', 'Hollow', 'Wildspring', 'Ironroot',
  'Duskbound', 'Ravenous', 'Silverleaf', 'Emberclad', 'Riftscar', 'Murkwater', 'Frostbound',
  'Thornweave', 'Skyfarer', 'Bloodmoon', 'Starlit', 'Grimwood', 'Copperfang', 'Wraithlit',
  'Ancient', 'Forsaken', 'Gilded', 'Whispering', 'Storm-Touched', 'Sable', 'Radiant', 'Broken',
];
const CREATURE_NOUN = [
  'Skitterfang', 'Acolyte', 'Serpent', 'Marauder', 'Colossus', 'Herald', 'Reaper', 'Cavalry',
  'Sentinel', 'Druid', 'Sphinx', 'Champion', 'Behemoth', 'Warden', 'Eel', 'Witch', 'Aven',
  'Custodian', 'Golem', 'Wyrm', 'Specter', 'Berserker', 'Scout', 'Cleric', 'Warrior', 'Elemental',
  'Knight', 'Wizard', 'Shaman', 'Griffin', 'Basilisk', 'Hydra', 'Naga', 'Djinn', 'Assassin',
];
const LAND_NOUN = [
  'Wastes', 'Bastion', 'Hollow', 'Reach', 'Marsh', 'Spire', 'Grove', 'Cataract', 'Expanse',
  'Sanctum', 'Basin', 'Foundry', 'Overlook', 'Crag', 'Delta', 'Vault',
];
const ARTIFACT_NOUN = [
  'Obelisk', 'Engine', 'Relic', 'Lantern', 'Automaton', 'Beacon', 'Shard', 'Censer', 'Loom',
  'Gauntlet', 'Idol', 'Prism',
];
const ENCHANT_NOUN = [
  'Whisper', 'Communion', 'Binding', 'Covenant', 'Vigil', 'Requiem', 'Aegis', 'Omen', 'Pact',
  'Ritual',
];
const SPELL_NOUN = [
  'Resolve', 'Gambit', 'Ambush', 'Verdict', 'Cascade', 'Reckoning', 'Surge', 'Snare', 'Flare',
  'Rebuke',
];
const PW_FIRST = ['Ashen', 'Vale', 'Kael', 'Sorin', 'Mira', 'Thess', 'Doran', 'Ysolde'];
const PW_EPITHET = [
  'the Marshal', 'Lichbane', 'the Unbroken', 'Stormcaller', 'the Wayward', 'Nightsworn',
  'the Kindled', 'Duskwarden',
];

const usedNames = new Set();
function generateUniqueName(kind) {
  for (let attempt = 0; attempt < 50; attempt++) {
    let name;
    if (kind === 'planeswalker') {
      name = `${pick(PW_FIRST)}, ${pick(PW_EPITHET)}`;
    } else if (kind === 'land') {
      name = `${pick(ADJ)} ${pick(LAND_NOUN)}`;
    } else if (kind === 'artifact') {
      name = `${pick(ADJ)} ${pick(ARTIFACT_NOUN)}`;
    } else if (kind === 'enchantment') {
      name = `${pick(ADJ)} ${pick(ENCHANT_NOUN)}`;
    } else if (kind === 'instant' || kind === 'sorcery') {
      name = `${pick(ADJ)}'s ${pick(SPELL_NOUN)}`;
    } else if (kind === 'battle') {
      name = `${pick(ADJ)} Siege of ${pick(LAND_NOUN)}`;
    } else {
      name = `${pick(ADJ)} ${pick(CREATURE_NOUN)}`;
    }
    if (!usedNames.has(name)) {
      usedNames.add(name);
      return name;
    }
  }
  // exceedingly unlikely fallback: disambiguate with a counter
  const fallback = `${pick(ADJ)} ${pick(CREATURE_NOUN)} #${usedNames.size}`;
  usedNames.add(fallback);
  return fallback;
}

const TYPE_KINDS = [
  { kind: 'creature', typeLine: (sub) => `Creature — ${sub}`, weight: 42 },
  { kind: 'land', typeLine: () => 'Land', weight: 10 },
  { kind: 'artifact', typeLine: () => 'Artifact', weight: 10 },
  { kind: 'enchantment', typeLine: () => 'Enchantment', weight: 10 },
  { kind: 'instant', typeLine: () => 'Instant', weight: 9 },
  { kind: 'sorcery', typeLine: () => 'Sorcery', weight: 9 },
  { kind: 'planeswalker', typeLine: () => 'Planeswalker', weight: 6 },
  { kind: 'battle', typeLine: () => 'Battle — Siege', weight: 4 },
];
const TYPE_KIND_TABLE = TYPE_KINDS.flatMap((t) => Array(t.weight).fill(t));

const CREATURE_SUBTYPES = [
  'Human Soldier', 'Elf Druid', 'Zombie Wizard', 'Goblin Warrior', 'Angel', 'Bird', 'Dragon',
  'Human Knight', 'Spirit', 'Beast', 'Merfolk Wizard', 'Vampire', 'Elemental', 'Giant',
];

const COLOR_POOL = ['W', 'U', 'B', 'R', 'G'];
function randomColorIdentity() {
  const roll = rand();
  if (roll < 0.12) return []; // colorless
  if (roll < 0.67) return [pick(COLOR_POOL)]; // mono, most common
  if (roll < 0.92) {
    // exactly 2 colors
    const a = pick(COLOR_POOL);
    let b = pick(COLOR_POOL);
    while (b === a) b = pick(COLOR_POOL);
    return [a, b];
  }
  // 3+ colors
  const shuffled = [...COLOR_POOL].sort(() => rand() - 0.5);
  return shuffled.slice(0, 3);
}

const RARITY_POOL = [
  ...Array(35).fill('common'),
  ...Array(30).fill('uncommon'),
  ...Array(25).fill('rare'),
  ...Array(10).fill('mythic'),
];

/**
 * Build one procedural staple card: picks a debut set (-> oldest-printing
 * year), a handful of later reprint sets, and computes each printing's
 * price from a target cheapest-printing price (`targetLo`) scaled by each
 * set's relative scarcity, so `targetLo` lands on whichever chosen set has
 * the lowest scarcity multiplier (almost always the most recent one).
 */
function buildStapleCard(targetLo, trackedHint = {}) {
  const typeKind = pick(TYPE_KIND_TABLE);
  const subtype = typeKind.kind === 'creature' ? pick(CREATURE_SUBTYPES) : null;
  const legendary = rand() < 0.15 || typeKind.kind === 'planeswalker';
  let typeLine = typeKind.typeLine(subtype);
  if (legendary) typeLine = `Legendary ${typeLine}`;
  const name = generateUniqueName(typeKind.kind);
  const colorIdentity = typeKind.kind === 'land' && rand() < 0.6 ? [] : randomColorIdentity();
  const rarity = pick(RARITY_POOL);

  const debutIdx = Math.floor(rand() * SET_POOL.length);
  const eligibleSets = SET_POOL.slice(debutIdx); // this set and everything released later
  const reprintCount = Math.min(eligibleSets.length, 3 + Math.floor(rand() * 4)); // 3-6
  const chosenSets = [eligibleSets[0]]; // always include the debut set itself
  const rest = eligibleSets.slice(1);
  while (chosenSets.length < reprintCount && rest.length > 0) {
    const idx = Math.floor(rand() * rest.length);
    chosenSets.push(rest.splice(idx, 1)[0]);
  }
  chosenSets.sort((a, b) => a.year - b.year);
  const minScarcity = Math.min(...chosenSets.map((s) => s.scarcity));

  const printings = chosenSets.map((s, i) => {
    const jitter = 1 + (rand() - 0.5) * 0.3;
    const price = Math.max(0.01, targetLo * (s.scarcity / minScarcity) * jitter);
    const hasFoil = s.year >= 2000;
    const hasEtched = s.scarcity <= 1.1 && rand() < 0.5; // only modern-ish sets
    return {
      set: s.code,
      setName: s.name,
      collector_number: 100 + i,
      releasedAt: `${s.year}-06-01`,
      rarity,
      edhrecRank: Math.floor(rand() * 25000),
      prices: {
        usd: price.toFixed(2),
        usd_foil: hasFoil ? (price * (1.8 + rand())).toFixed(2) : null,
        usd_etched: hasEtched ? (price * (2.6 + rand())).toFixed(2) : null,
      },
    };
  });

  addPrintings({ name, typeLine, colorIdentity, printings });
  return { name, oracleId: uuidLike(`oracle-${name}`), targetLo, trackedHint };
}

// Value tiers -> counts and $target ranges for the CHEAPEST printing (`lo`).
// Sums to 220 staple cards; combined with the 7 hand-authored vintage-chase
// cards and ~12 edge-case cards below, that's ~239 oracle ids total, and
// (7 + 33 + 110 + a handful of edge cases) ≈ 150-165 tracked (>= $0.50).
const staples = [];
for (let i = 0; i < 33; i++) staples.push(buildStapleCard(50 + rand() * 450, { tier: 'high' })); // $50-500
for (let i = 0; i < 110; i++) staples.push(buildStapleCard(0.5 + rand() * 49.5, { tier: 'mid' })); // $0.50-50
for (let i = 0; i < 70; i++) staples.push(buildStapleCard(0.02 + rand() * 0.47, { tier: 'bulk' })); // $0.02-0.49 (untracked)

// ---------------------------------------------------------------------------
// 2) Hand-authored vintage "chase" cards: the $1,000-$30,000 long tail.
//    A few are reprint pairs (old printing very expensive, modern reprint
//    cheap, like the classic power-card pattern); a few are single-printing
//    cards where even the cheapest (only) printing is itself 4-5 figures.
// ---------------------------------------------------------------------------

// $12,000 Alpha-era reserved-list dual land -- the original price outlier +
// reserved flag (kept byte-for-byte from the original fixture set).
addPrintings({
  name: 'Volcanic Mire',
  typeLine: 'Land — Island Mountain',
  colorIdentity: ['U', 'R'],
  reserved: true,
  printings: [
    {
      set: 'lea',
      setName: 'Limited Edition Alpha',
      collector_number: 280,
      releasedAt: '1993-08-05',
      rarity: 'rare',
      edhrecRank: 450,
      prices: { usd: '12000.00', usd_foil: null, usd_etched: null },
    },
    {
      // a cheap modern reprint of the same card, to exercise "cheapest
      // printing across all printings" picking this one instead.
      set: 'sho',
      setName: 'Shadows of the Horizon',
      collector_number: 301,
      releasedAt: '2026-06-01',
      rarity: 'rare',
      edhrecRank: 450,
      prices: { usd: '38.00', usd_foil: '61.00', usd_etched: null },
    },
  ],
});

addPrintings({
  name: 'Ancient Tomb of Kessig',
  typeLine: 'Land',
  colorIdentity: [],
  reserved: true,
  printings: [
    {
      set: 'lea',
      setName: 'Limited Edition Alpha',
      collector_number: 281,
      releasedAt: '1993-08-05',
      rarity: 'rare',
      edhrecRank: 210,
      prices: { usd: '18500.00', usd_foil: null, usd_etched: null },
    },
  ],
});

addPrintings({
  name: "Serra's Lost Cathedral",
  typeLine: 'Legendary Land',
  colorIdentity: ['W'],
  printings: [
    {
      set: 'leb',
      setName: 'Limited Edition Beta',
      collector_number: 282,
      releasedAt: '1994-10-01',
      rarity: 'rare',
      edhrecRank: 890,
      prices: { usd: '9500.00', usd_foil: null, usd_etched: null },
    },
    {
      set: 'sho',
      setName: 'Shadows of the Horizon',
      collector_number: 302,
      releasedAt: '2026-06-01',
      rarity: 'rare',
      edhrecRank: 890,
      prices: { usd: '22.00', usd_foil: '34.00', usd_etched: null },
    },
  ],
});

addPrintings({
  name: "Mishra's Forgotten Engine",
  typeLine: 'Legendary Artifact',
  colorIdentity: [],
  reserved: true,
  printings: [
    {
      set: 'usg',
      setName: "Urza's Saga",
      collector_number: 283,
      releasedAt: '1999-10-11',
      rarity: 'rare',
      edhrecRank: 1500,
      prices: { usd: '4200.00', usd_foil: null, usd_etched: null },
    },
  ],
});

addPrintings({
  name: 'The Precursor Golem',
  typeLine: 'Legendary Artifact Creature — Golem',
  colorIdentity: [],
  printings: [
    {
      set: 'tmp',
      setName: 'Tempest',
      collector_number: 284,
      releasedAt: '1997-10-14',
      rarity: 'rare',
      edhrecRank: 3300,
      prices: { usd: '15000.00', usd_foil: null, usd_etched: null },
    },
    {
      set: 'sho',
      setName: 'Shadows of the Horizon',
      collector_number: 303,
      releasedAt: '2026-06-01',
      rarity: 'mythic',
      edhrecRank: 3300,
      prices: { usd: '65.00', usd_foil: '110.00', usd_etched: '145.00' },
    },
  ],
});

addPrintings({
  name: "Gaea's Cradle Prototype",
  typeLine: 'Legendary Land',
  colorIdentity: ['G'],
  reserved: true,
  printings: [
    {
      set: 'leb',
      setName: 'Limited Edition Beta',
      collector_number: 285,
      releasedAt: '1994-10-01',
      rarity: 'rare',
      edhrecRank: 95,
      prices: { usd: '27500.00', usd_foil: null, usd_etched: null },
    },
  ],
});

addPrintings({
  name: 'Moxie Shard',
  typeLine: 'Legendary Artifact',
  colorIdentity: [],
  reserved: true,
  printings: [
    {
      set: 'lea',
      setName: 'Limited Edition Alpha',
      collector_number: 286,
      releasedAt: '1993-08-05',
      rarity: 'rare',
      edhrecRank: 60,
      prices: { usd: '6800.00', usd_foil: null, usd_etched: null },
    },
    {
      set: 'sho',
      setName: 'Shadows of the Horizon',
      collector_number: 304,
      releasedAt: '2026-06-01',
      rarity: 'mythic',
      edhrecRank: 60,
      prices: { usd: '12.00', usd_foil: '19.00', usd_etched: null },
    },
  ],
});

// ---------------------------------------------------------------------------
// 3) Other deliberate edge cases called out in the task.
// ---------------------------------------------------------------------------

// A very cheap common with a bonus-sheet reprint (rarity code 4).
addPrintings({
  name: 'Puddlejump Newt',
  typeLine: 'Creature — Frog',
  colorIdentity: ['G'],
  printings: [
    {
      set: 'm10',
      setName: 'Magic 2010',
      collector_number: 150,
      releasedAt: '2009-07-17',
      rarity: 'common',
      prices: { usd: '0.02', usd_foil: '0.10', usd_etched: null },
    },
    {
      set: 'sho',
      setName: 'Shadows of the Horizon',
      collector_number: 402,
      releasedAt: '2026-06-01',
      rarity: 'bonus',
      prices: { usd: '0.35', usd_foil: null, usd_etched: null },
    },
  ],
});

// Foil-only promo (no nonfoil price at all).
addPrintings({
  name: 'Prerelease Ember-Knight',
  typeLine: 'Creature — Human Knight',
  colorIdentity: ['R'],
  printings: [
    {
      set: 'sho',
      setName: 'Shadows of the Horizon',
      setType: 'promo',
      collector_number: '5s',
      releasedAt: '2026-05-20',
      rarity: 'rare',
      prices: { usd: null, usd_foil: '9.50', usd_etched: null },
    },
  ],
});

// Double-faced card with NO top-level type_line/image_uris -- exercises the
// card_faces[0] fallback for both typeBitmask() and imageKey().
{
  const frontId = uuidLike('print-Nightfall Cartographer//Dawnlit Chart-sho-en-321');
  const backId = frontId; // faces share the printing id in real Scryfall data
  addPrintings({
    name: 'Nightfall Cartographer // Dawnlit Chart',
    layout: 'transform',
    colorIdentity: ['U'],
    topLevelTypeLine: false,
    cardFaces: [
      {
        name: 'Nightfall Cartographer',
        type_line: 'Creature — Human Scout',
        image_uris: { normal: imageUrl(frontId) },
      },
      {
        name: 'Dawnlit Chart',
        type_line: 'Land',
        image_uris: { normal: imageUrl(backId) },
      },
    ],
    printings: [
      {
        set: 'sho',
        setName: 'Shadows of the Horizon',
        collector_number: 321,
        releasedAt: '2026-06-01',
        rarity: 'rare',
        prices: { usd: '1.20', usd_foil: '2.40', usd_etched: null },
      },
    ],
  });
}

// Non-English printing of a card that ALSO has an English printing ->
// the Japanese printing must be excluded from tracking.
addPrintings({
  name: 'Twinlight Oracle',
  typeLine: 'Creature — Human Wizard',
  colorIdentity: ['W', 'U'],
  printings: [
    {
      set: 'sho',
      setName: 'Shadows of the Horizon',
      collector_number: 88,
      releasedAt: '2026-06-01',
      rarity: 'rare',
      prices: { usd: '3.00', usd_foil: '5.50', usd_etched: null },
    },
    {
      set: 'sho',
      setName: 'Shadows of the Horizon',
      collector_number: '88s',
      lang: 'ja',
      releasedAt: '2026-06-01',
      rarity: 'rare',
      prices: { usd: '7.00', usd_foil: null, usd_etched: null },
    },
  ],
});

// Non-English-ONLY card (Japanese-exclusive promo) -> kept, per the
// "unless it is the only printing of that card" exception.
addPrintings({
  name: '電光の旅人', // "Lightning Traveler" in Japanese
  typeLine: 'Creature — Human Wizard',
  colorIdentity: ['U', 'R'],
  printings: [
    {
      set: 'sho',
      setName: 'Shadows of the Horizon',
      setType: 'promo',
      lang: 'ja',
      collector_number: '99jp',
      releasedAt: '2026-05-01',
      rarity: 'mythic',
      prices: { usd: '18.00', usd_foil: null, usd_etched: null },
    },
  ],
});

// Excluded: digital-only (Arena), oversized, token, and alchemy/minigame set types.
addPrintings({
  name: 'Arena Test Beast',
  typeLine: 'Creature — Beast',
  colorIdentity: ['G'],
  printings: [
    {
      set: 'sho',
      setName: 'Shadows of the Horizon',
      collector_number: 500,
      releasedAt: '2026-06-01',
      rarity: 'rare',
      digital: true,
      games: ['arena'],
      prices: { usd: '2.00', usd_foil: null, usd_etched: null },
    },
  ],
});
addPrintings({
  name: 'Oversized Command Tower',
  typeLine: 'Land',
  colorIdentity: [],
  printings: [
    {
      set: 'sho',
      setName: 'Shadows of the Horizon',
      collector_number: 'OS1',
      releasedAt: '2026-06-01',
      rarity: 'common',
      oversized: true,
      prices: { usd: '4.00', usd_foil: null, usd_etched: null },
    },
  ],
});
addPrintings({
  name: 'Beast Token',
  typeLine: 'Token Creature — Beast',
  colorIdentity: ['G'],
  layout: 'token',
  printings: [
    {
      set: 'tsho',
      setName: 'Shadows of the Horizon Tokens',
      setType: 'token',
      collector_number: 1,
      releasedAt: '2026-06-01',
      rarity: 'common',
      prices: { usd: '0.25', usd_foil: null, usd_etched: null },
    },
  ],
});
addPrintings({
  name: 'Chaos Rift Puzzle',
  typeLine: 'Instant',
  colorIdentity: ['R'],
  printings: [
    {
      set: 'ash1',
      setName: 'Alchemy Horizons',
      setType: 'alchemy',
      collector_number: 12,
      releasedAt: '2026-01-01',
      rarity: 'rare',
      digital: true,
      games: ['arena'],
      prices: { usd: '1.50', usd_foil: null, usd_etched: null },
    },
  ],
});

console.log(`Generated ${cards.length} Scryfall printing records (${usedNames.size} procedural names).`);

// ---------------------------------------------------------------------------
// MTGJSON identifiers + 95-day price history, mapped to a subset of the
// Scryfall printings above (paper, English, priced ones), so seed-mtgjson.mjs
// has real oracle ids to join against.
//
// Most cards get gentle daily noise around today's price (organic 30d/90d
// drift falls out of the random walk on its own). A curated subset gets a
// deliberate "shape" instead, so the Trends view has an obvious, demo-worthy
// story: sharp 1-3 day spikes/drops, and clean multi-week trends.
// ---------------------------------------------------------------------------

const seedable = cards.filter(
  (c) => c.lang === 'en' && !c.digital && !c.oversized && c.prices && c.prices.usd,
);

const identifiers = { meta: { version: '5.2.2', date: ANCHOR_DAY }, data: {} };
const priceData = { meta: { version: '5.2.2', date: ANCHOR_DAY }, data: {} };

const days = [];
for (let i = MTGJSON_DAYS - 1; i >= 0; i--) {
  days.push(isoDaysBack(ANCHOR_DAY, i + 1)); // ends the day BEFORE anchor day
}

// Pick movers from the $50-500 "high" tier so their swings clear the
// $1.00 movers_min_cents floor by a wide margin and read clearly in a demo.
const highTierOracleIds = staples.filter((s) => s.trackedHint?.tier === 'high').map((s) => s.oracleId);
function takeMovers(n, excludeSet) {
  const out = [];
  for (const oid of highTierOracleIds) {
    if (out.length >= n) break;
    if (excludeSet.has(oid)) continue;
    out.push(oid);
    excludeSet.add(oid);
  }
  return out;
}
const usedAsMovers = new Set();
const spikeUpIds = new Set(takeMovers(8, usedAsMovers));
const spikeDownIds = new Set(takeMovers(8, usedAsMovers));
const uptrendIds = new Set(takeMovers(6, usedAsMovers));
const downtrendIds = new Set(takeMovers(6, usedAsMovers));

/**
 * Build a 95-value price history ending (at index n-1, "yesterday") near
 * `endValue`, which is always the card's real, fixed "today" price from the
 * Scryfall fixture -- so whatever shape we draw here reads correctly when
 * ingest.mjs's snapshot of "today" is compared against it.
 */
function buildWalk(n, endValue, shape) {
  let startValue = endValue;
  if (shape === 'uptrend') startValue = endValue / (1.6 + rand() * 1.4); // was 60-300% lower
  else if (shape === 'downtrend') startValue = endValue * (1.6 + rand() * 1.4); // was 60-300% higher

  const logStart = Math.log(startValue);
  const logEnd = Math.log(endValue);
  const values = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const base = Math.exp(logStart + (logEnd - logStart) * t);
    const noise = 1 + (rand() - 0.5) * 0.03; // +/-1.5% daily noise on top of the trend
    values[i] = base * noise;
  }

  if (shape === 'spike-up' || shape === 'spike-down') {
    const spikeDays = 1 + Math.floor(rand() * 3); // last 1-3 days
    const factor = 2 + rand() * 3; // 2x-5x
    for (let k = 0; k < spikeDays; k++) {
      const idx = n - 1 - k;
      const mult = shape === 'spike-up' ? 1 / factor : factor;
      values[idx] = endValue * mult * (1 + (rand() - 0.5) * 0.05);
    }
  }

  return values.map((v) => Math.max(0.01, Number(v.toFixed(2))));
}

function shapeFor(oracleId) {
  if (spikeUpIds.has(oracleId)) return 'spike-up';
  if (spikeDownIds.has(oracleId)) return 'spike-down';
  if (uptrendIds.has(oracleId)) return 'uptrend';
  if (downtrendIds.has(oracleId)) return 'downtrend';
  return 'flat';
}

for (const c of seedable) {
  const uuid = uuidLike(`mtgjson-${c.id}`);
  identifiers.data[uuid] = {
    identifiers: { scryfallId: c.id, scryfallOracleId: c.oracle_id },
  };

  const baseNormal = parseFloat(c.prices.usd);
  const baseFoil = c.prices.usd_foil ? parseFloat(c.prices.usd_foil) : null;
  const shape = shapeFor(c.oracle_id);

  const normalValues = buildWalk(days.length, baseNormal, shape);
  const normal = Object.fromEntries(days.map((day, i) => [day, normalValues[i]]));

  const retail = { normal };
  if (baseFoil !== null) {
    const foilValues = buildWalk(days.length, baseFoil, shape);
    retail.foil = Object.fromEntries(days.map((day, i) => [day, foilValues[i]]));
  }
  priceData.data[uuid] = { paper: { tcgplayer: { retail } } };
}

// A couple of uuids with no Scryfall mapping at all, and identifiers with
// no matching price entry -- both should be silently skipped, not crash.
priceData.data[uuidLike('mtgjson-orphan-price')] = {
  paper: { tcgplayer: { retail: { normal: { [days[0]]: 1.23 } } } },
};
identifiers.data[uuidLike('mtgjson-orphan-identifier')] = {
  identifiers: { scryfallId: uuidLike('nowhere'), scryfallOracleId: uuidLike('nowhere-oracle') },
};

console.log(
  `Generated MTGJSON fixtures: ${Object.keys(identifiers.data).length} identifiers, ` +
    `${Object.keys(priceData.data).length} priced uuids, ${days.length} days ` +
    `(${days[0]} .. ${days[days.length - 1]}).`,
);
console.log(
  `  shaped movers: ${spikeUpIds.size} spike-up, ${spikeDownIds.size} spike-down, ` +
    `${uptrendIds.size} uptrend, ${downtrendIds.size} downtrend`,
);

// ---------------------------------------------------------------------------
// Write files
// ---------------------------------------------------------------------------

function parseOutArg(argv) {
  const i = argv.indexOf('--out');
  return i === -1 ? 'fixtures' : argv[i + 1];
}

export function writeFixtures(outDir = 'fixtures') {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'scryfall-default-cards.json'), JSON.stringify(cards));
  fs.writeFileSync(path.join(outDir, 'mtgjson-identifiers.json'), JSON.stringify(identifiers));
  fs.writeFileSync(path.join(outDir, 'mtgjson-prices.json'), JSON.stringify(priceData));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outDir = parseOutArg(process.argv.slice(2));
  writeFixtures(outDir);
  console.log(`Wrote fixtures to ${outDir}/`);
}
