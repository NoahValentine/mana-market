# Mana Market — data & API contract (v1)

A Scryfall redesign focused on the card market. Mobile-first, static-first.

## Product decisions (locked)

- **Price basis:** TCGplayer market price = Scryfall `prices.usd` / `usd_foil` / `usd_etched`.
- **Default headline price:** *cheapest printing, any finish* (`lo`). Toggle switches every
  list/sort/filter to *most expensive printing* (`hi`).
- **Universe:** paper, real cards. Excluded from the tracked pack: `digital`, `oversized`,
  set types `memorabilia`/`token`/`minigame`/`alchemy`, layouts `token|double_faced_token|emblem|art_series|vanguard|scheme|planar` (planar/scheme/vanguard kept? no — excluded),
  and non-English printings (`lang != "en"`) unless it is the only printing of that card.
  Search view can re-enable extras via filter chips (`include_extras=true`).
- **Trends:** 24h / 7d / 30d / 90d % gain + loss, computed from our own daily snapshots,
  seeded with ~90 days of TCGplayer history from MTGJSON.
- **Name:** Mana Market. Host: Cloudflare Pages (static) + one small Worker for push.

## Two data sources at runtime

1. **Static market pack** (`/data/*`, rebuilt nightly by CI) — powers Market, Trends,
   price-range queries, sorting, sparklines. One fetch, cached in IndexedDB.
2. **Live Scryfall API** (browser → `https://api.scryfall.com`, CORS ok) — powers the
   Search view (full Scryfall syntax), card detail pages, all printings, deck valuation,
   watchlist refresh. Client rules: `User-Agent` cannot be set in browsers, so send
   `Accept: application/json`; throttle to **max 2 requests/sec** for
   `/cards/search`, `/cards/named`, `/cards/random`, `/cards/collection`, 10/s elsewhere;
   cache responses in-memory + sessionStorage for 24h (prices only change daily).

## Static files under `public/data/`

All emitted by `scripts/build-pack.mjs`. Cloudflare compresses on the fly; do not pre-gzip.

### `meta.json`
```json
{
  "generated_at": "2026-09-02T08:04:00Z",
  "scryfall_bulk_updated_at": "2026-09-02T07:12:33Z",
  "days": ["2026-06-05", "...", "2026-09-02"],
  "card_count": 21873,
  "min_tracked_cents": 50,
  "series": { "rows": 21873, "cols": 90, "bytes_per_value": 4, "row_bytes": 360 },
  "index_windows": [1, 7, 30, 90]
}
```
`days` is ascending and is the column axis for `series.bin`. Missing day for a card = `-1`.

### `cards.json`
Array-of-arrays to keep it small. `cards.json` is `{ "fields": [...], "rows": [[...]] }`
where `fields` is exactly, in order:

| idx | key    | type   | meaning |
|-----|--------|--------|---------|
| 0   | `oid`  | string | Scryfall `oracle_id` (the card identity; row key) |
| 1   | `n`    | string | card name |
| 2   | `lo`   | int    | cheapest printing price, **cents**, any finish |
| 3   | `loId` | string | Scryfall printing `id` of the cheapest printing |
| 4   | `loF`  | int    | finish of `lo`: 0 nonfoil, 1 foil, 2 etched |
| 5   | `loS`  | string | set code of cheapest printing |
| 6   | `hi`   | int    | most expensive printing price, cents |
| 7   | `hiId` | string | printing id of the most expensive printing |
| 8   | `hiF`  | int    | finish of `hi` |
| 9   | `hiS`  | string | set code of most expensive printing |
| 10  | `np`   | int    | number of tracked paper printings |
| 11  | `r`    | int    | rarity of cheapest printing: 0 common, 1 uncommon, 2 rare, 3 mythic, 4 special/bonus |
| 12  | `cid`  | string | color identity letters, e.g. `"WUB"`, `""` for colorless |
| 13  | `t`    | int    | type bitmask: 1 creature, 2 instant, 4 sorcery, 8 artifact, 16 enchantment, 32 planeswalker, 64 land, 128 battle, 256 legendary |
| 14  | `res`  | int    | 1 if on the Reserved List |
| 15  | `yr`   | int    | year of the oldest paper printing |
| 16  | `d1`   | int    | % change vs 1 day ago, ×100 (e.g. `-1234` = −12.34%); `null` if unknown |
| 17  | `d7`   | int    | % change vs 7 days ago, ×100 |
| 18  | `d30`  | int    | % change vs 30 days ago, ×100 |
| 19  | `d90`  | int    | % change vs 90 days ago, ×100 |
| 20  | `row`  | int    | row index into `series.bin` |
| 21  | `img`  | string | image key for the cheapest printing (see below) |
| 22  | `cn`   | string | collector number of cheapest printing |
| 23  | `edh`  | int    | Scryfall `edhrec_rank` or `0` |

% changes are computed on the **cheapest-printing** series. Rows are sorted by `lo`
descending, so "most expensive cards" is `rows.slice(0, n)` with no client-side sort.

**Image key (`img`)**: Scryfall image URLs look like
`https://cards.scryfall.io/<size>/front/a/b/<id>.jpg?<ts>`. Store only `"<a><b>"` is not
enough — store `img` as the string `"<face>/<a>/<b>/<id>.jpg?<ts>"` taken from the card's
`image_uris.normal` path after the size segment, so the client can build any size:
`https://cards.scryfall.io/${size}/${img}` with `size` in
`small|normal|large|png|art_crop|border_crop`. If a card has no `image_uris` (multi-face),
use face 0's.

### `series.bin`
Raw `Int32Array` little-endian matrix, `rows × cols`, row-major, values in **cents**,
`-1` = no data. Row `i` is at byte offset `i * cols * 4`. Clients fetch a single row with
an HTTP `Range: bytes=<off>-<off+row_bytes-1>` request (Cloudflare Pages supports ranges);
Trends/Market never need it — only charts do.

### `trends.json`
Precomputed leaderboards so the Trends view is instant and does not need `series.bin`:
```json
{
  "generated_at": "...",
  "windows": {
    "d1":  { "gainers": [[oid, pct, lo_now, lo_then], ...200], "losers": [...200] },
    "d7":  { ... }, "d30": { ... }, "d90": { ... }
  },
  "movers_min_cents": 100,
  "index": {
    "days": ["..."],
    "top100": [ ...total cents of the 100 most expensive cards, per day... ],
    "top1000": [ ... ],
    "median": [ ... ],
    "movers_up": [ ...count of cards up >5% that day... ],
    "movers_down": [ ... ]
  },
  "sets": [ { "code": "lea", "name": "Limited Edition Alpha", "total": 12345678, "d7": 123 } ]
}
```
`oid` refers to a row in `cards.json`; the client joins by `oid` for name/image.
Cards below `movers_min_cents` ($1.00) are excluded from leaderboards so penny-card noise
(a $0.02 → $0.06 jump = +200%) never tops the list.

### `history/<day>.csv`
Committed daily snapshots (the durable history, ~150 KB/day gzipped).
Header: `oracle_id,lo_cents,lo_printing,lo_finish,hi_cents,hi_printing,hi_finish`.
`build-pack.mjs` reads the last 90 of these to build `series.bin` + `trends.json`.

## Worker API (push + watchlist sync only)

Base: same origin, `/api/*`. Everything else is static.

| Method | Path | Body / query | Returns |
|---|---|---|---|
| `GET`  | `/api/vapid` | — | `{ "publicKey": "..." }` |
| `POST` | `/api/subscribe` | `{ endpoint, keys:{p256dh, auth}, rules:[{oid, name, dir:"up"\|"down", cents}] }` | `{ ok:true, id }` |
| `POST` | `/api/unsubscribe` | `{ endpoint }` | `{ ok:true }` |
| `GET`  | `/api/subs` | header `X-Admin-Token` | NDJSON of subscriptions (CI reads this to send push) |
| `POST` | `/api/sent` | header `X-Admin-Token`, `{ dead:[endpoint...] }` | `{ ok:true }` prunes dead endpoints |

Storage: Workers KV namespace `SUBS`, key = sha256(endpoint), value = the subscribe body.
Secrets: `ADMIN_TOKEN`, `VAPID_PUBLIC_KEY` (KV/vars). Private VAPID key lives **only** in
GitHub Actions secrets — the Worker never sees it.

Alerts are sent by `scripts/send-alerts.mjs` in CI after the nightly pack build, using the
`web-push` npm package. If push is unavailable (iOS Safari not installed to home screen,
permission denied), the app falls back to an in-app "movers in your watchlist" badge
computed from `cards.json` on load.

## Scryfall query construction (Search view)

Always append: `game:paper` and, unless the user enables extras, `-is:digital`.
- price basis cheapest → add `prefer:usd-low unique:cards`; most expensive → `prefer:usd-high unique:cards`;
  "show every printing" toggle → `unique:prints`.
- price range → `usd>=<min> usd<=<max>` (omit either side when blank).
- sort → `order=usd&dir=desc|asc` as **query params**, not keywords.
- Pagination via `next_page` from the response; 175 cards per page.
- Never build a query the user cannot see: the raw Scryfall query string is always shown
  in an editable box (power users type syntax directly; chips write into the same box).

## Attribution / ToS

Footer on every page: "Card data and images from Scryfall. Prices are TCGplayer market
prices, updated daily. Mana Market is unofficial Fan Content permitted under the Wizards
of the Coast Fan Content Policy. Not approved/endorsed by Wizards or Scryfall."
Bulk data is used for the nightly job (Scryfall requires bulk files, not the API, for
price-wide scans); the app caches Scryfall responses ≥24h.
