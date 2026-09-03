Daily price snapshots live here, one CSV per day:

  oracle_id,lo_cents,lo_printing,lo_finish,hi_cents,hi_printing,hi_finish

They are the durable price history (about 150 KB per day) and the only thing the
nightly workflow commits back to the repo. `npm run pack` turns the last 90 of
them into public/data/{meta,cards,trends}.json + series.bin.

Written by:
  npm run ingest   today's snapshot from Scryfall's bulk data
  npm run seed     a ~90-day backfill from MTGJSON (the "Seed" workflow)
