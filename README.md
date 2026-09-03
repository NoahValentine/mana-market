# Mana Market

A price-first redesign of Scryfall: the most expensive Magic cards, what they did
in the last 24 hours / 7 / 30 / 90 days, and every card's cheapest printing.
Mobile and desktop, installable as a phone app, no login.

- **Prices**: TCGplayer market price, via Scryfall's `usd` / `usd_foil` / `usd_etched`.
- **Default basis**: cheapest printing of a card, any finish. One toggle switches
  every list, sort and filter to the most expensive printing.
- **Images and card data**: Scryfall, live.
- **Trends**: computed from our own daily snapshots, seeded with ~90 days of
  TCGplayer history from MTGJSON.

---

## The five views

| View | What it does | Where the data comes from |
|---|---|---|
| **Market** | Every tracked card, ranked by price. Price-range presets plus a custom min/max, sort by price or by 24h/7d/30d/90d move, filter by colour, rarity, type, Reserved List, name or set. | The static pack — filtering is instant, no network |
| **Trends** | Biggest gainers and losers per window, a market index chart (top 100 / top 1000 / median), how many cards moved more than 5%, and set-level totals. | `trends.json` in the pack |
| **Search** | The real Scryfall search box. Every filter chip writes into a query string you can see and edit. Price range becomes `usd>=x usd<=y`, sort becomes `order=usd`, and the printing preference becomes `prefer:usd-low` / `prefer:usd-high`. | Live Scryfall API |
| **Card** | Full card image (flippable for double-faced cards), oracle text, every paper printing with nonfoil/foil/etched prices and the cheapest highlighted, a price-history chart, legality, rulings, and buy links. | Live Scryfall + history from the pack |
| **Watchlist / Deck value** | Star cards to track your own gain/loss and arm price alerts. Paste a decklist (or a Moxfield export) to value a deck at cheapest printings. | Pack first, Scryfall for anything below the tracking threshold |

Everything is kept honest about its own freshness: Scryfall syncs prices once a
day, so the app shows the snapshot date rather than pretending to be real-time.

---

## How it is put together

```
public/            the whole app — plain ES modules, no build step
  index.html       shell: header, tabs, bottom nav
  css/app.css      one stylesheet, dark first, light theme via the toggle
  js/data.js       loads the static pack; pulls one card's history with a Range request
  js/scryfall.js   throttled + cached Scryfall client and the query builder
  js/views/*.js    market, trends, search, card, watchlist, deck
  sw.js            offline shell, image cache, push handler
  data/            the built pack (see public/data/README.txt)
history/           one CSV per day — the durable price history (~150 KB/day)
scripts/           ingest, MTGJSON seed, pack build, alert sender
worker/            optional Cloudflare Worker (only for real web-push)
test/              pipeline tests, frontend unit tests, browser smoke test
SPEC.md            the data contract every piece agrees on
```

Two data paths, on purpose:

1. **A static pack** (`public/data`, ~1–2 MB, rebuilt nightly) holds every tracked
   card with its cheapest and most expensive printing, the four percent-change
   windows, and a 90-day series. The Market and Trends views work entirely off
   this, so sorting 20,000 cards or dragging a price range is instant and costs
   no API calls. Per-card history comes out of `series.bin` with a 360-byte HTTP
   Range request.
2. **The live Scryfall API** for search, card pages, printings and deck pricing —
   throttled to Scryfall's limits (2 req/s on search, 10 elsewhere) and cached for
   24 hours, because that is how often prices change.

Scryfall asks that price-wide scans use the bulk files rather than the API, which
is exactly what the nightly job does.

---

## Run it locally

```bash
npm install
npm run dev            # http://localhost:8787
```

To check the sub-path shape GitHub Pages uses: `BASE_PATH=/mana-market npm run dev`
then open `http://localhost:8787/mana-market/`.

That serves `public/` with byte-range support (needed for `series.bin`). The
committed pack is demo data — real card names, synthetic prices — so the app has
something to show before the first real ingest.

To pull real prices (needs internet access to Scryfall):

```bash
npm run ingest         # downloads Scryfall's default_cards bulk file -> history/<today>.csv
npm run pack           # history/*.csv -> public/data/{meta,cards,trends}.json + series.bin
```

Tests:

```bash
npm test               # pipeline + frontend unit tests (fast)
npm run test:ui        # headless browser smoke test, writes screenshots/
```

---

## Deploy (GitHub Pages — free, no card, nothing else to sign up for)

Hosting is GitHub Pages; the nightly price refresh is GitHub Actions; phone
alerts go through ntfy.sh (free app, no account). Nothing else is needed.

### 1. Create the repo and push

```bash
cd mana-market
git init -b main
git add -A
git commit -m "Mana Market"
gh repo create mana-market --public --source=. --push
```

A private repo works too, but Pages on a private repo needs a paid plan, so use
public unless you have GitHub Pro.

### 2. Turn Pages on

Repo → Settings → Pages → **Source: GitHub Actions**. Nothing else to configure.

### 3. First deploy

Actions → **Deploy to Pages** → Run workflow. When it finishes, the URL is at the
bottom of the run (and under Settings → Pages) — usually
`https://<you>.github.io/mana-market/`. The site works under that sub-path; no
custom domain needed.

That first deploy ships the demo pack. Real prices arrive in the next step.

### 4. Real prices

Actions → **Nightly prices** → Run workflow. It downloads Scryfall's bulk file,
builds the pack, commits the day's history CSV, and redeploys. After that it runs
itself at 09:00 UTC daily.

### 5. Seed 90 days of history

Actions → **Seed 90-day history from MTGJSON** → Run workflow. It maps MTGJSON's
TCGplayer history onto Scryfall oracle ids and writes one `history/<day>.csv` per
day, so the 24h/7d/30d/90d movers work immediately instead of filling in over
three months. Takes 20–40 minutes; safe to re-run (it never overwrites a day).

Then re-run **Nightly prices** (or wait for tomorrow) to fold the seeded days
into the pack.

### 6. Phone alerts

1. Install **ntfy** (App Store / Play Store).
2. Open the site → Watchlist → tap **Make one up** to get a topic name, then
   subscribe to that topic in the ntfy app.
3. Optional, for your own price thresholds: arm alerts on card pages, then hit
   **Copy alerts.json** on the Watchlist screen and commit that file to the repo
   root. Big daily spikes (>25% on anything worth $5+) are alerted with or
   without it.

Prefer to keep the topic out of a public repo? Put it in a repo secret named
`NTFY_TOPIC` instead — the workflow passes it through and it overrides the file.

### Add to your phone's home screen

Open the site on your phone → Share → **Add to Home Screen**. It then runs
full-screen, keeps recently viewed cards offline, and gets its own icon.

### Optional: real web-push instead of ntfy

`worker/index.js` + `wrangler.toml` + `scripts/send-alerts.mjs` are a small
Cloudflare Worker that stores push subscriptions and sends true web-push
notifications. Unused in the Pages setup; if you ever want it, deploy the Worker
(`npx wrangler deploy`), point the app at it, and swap `npm run alerts` for
`npm run alerts:webpush` in the nightly workflow.

## Knobs worth knowing

| What | Where |
|---|---|
| Tracking threshold (default: cards whose cheapest printing is ≥ $0.50) | `npm run pack -- --min-cents 50` |
| Minimum price to appear in the movers leaderboards (default $1.00) | `MOVERS_MIN_CENTS` in `scripts/build-pack.mjs` |
| How many days of history the pack carries (default 90) | `npm run pack -- --max-days 90` |
| Which printings count as "real cards" | the exclusion rules in `scripts/lib/scryfall.mjs`, spelled out in SPEC.md |
| Nightly run time | the cron in `.github/workflows/nightly.yml` (UTC) |
| Spike-alert threshold and floor | `spike_pct` / `spike_min_dollars` in `alerts.json` |

---

## What was verified, and what wasn't

Built and checked in a sandbox with no route to Scryfall, MTGJSON or Cloudflare,
so:

- **Verified**: 37 automated tests (cheapest/priciest selection across finishes,
  exclusion rules, cents rounding, CSV round-trip, percent-change maths with
  missing days, movers eligibility, pack shape against SPEC, query building,
  price parsing) plus a headless-browser pass over all five views at 390 px and
  1440 px that fails on any console error, on a sideways-scrolling layout, or if
  the price-range filter lets a card through. Screenshots in `screenshots/`.
- **Verified too**: the whole suite runs a second time with the app served under
  a `/mana-market/` sub-path, which is the shape GitHub Pages serves.
- **Not verified**: the first real Scryfall bulk download, the MTGJSON seed
  against the real files, the Pages deploy itself, and a real ntfy delivery. The scripts are written against the documented shapes and run
  end-to-end on synthetic fixtures (`npm run fixtures`), but expect to fix a
  detail or two on the first live run.

A gain is always drawn with a `▲ +` / `▼ −` sign as well as colour, and the
green/red pair was checked for colour-blind separation rather than eyeballed.

---

## Ideas parked for later

- Reprint-risk flag (cards not reprinted in N years and climbing).
- Foil multiplier view: which cards carry the biggest foil premium.
- "Spike detector" push: anything up more than 30% overnight, watchlist or not.
- Set-level index pages with a chart per set.
- Collection import (CSV from TCGplayer / Moxfield) with cost basis.
- EUR / MTGO tix as a currency toggle (the fields are already in the bulk data).

---

## Attribution

Card data and images from [Scryfall](https://scryfall.com). Prices are TCGplayer
market prices as published by Scryfall, updated once daily. Historical prices via
[MTGJSON](https://mtgjson.com).

Mana Market is unofficial Fan Content permitted under the Wizards of the Coast Fan
Content Policy. Not approved or endorsed by Wizards of the Coast or Scryfall.
Portions of the materials used are property of Wizards of the Coast LLC.
