# Phase Business Lookup service

A tiny, dependency-free Python HTTP service over the SQLite FTS5 store
built from **Overture Maps Places** (US + Canada, open businesses only —
19,444,739 records in the 2026-10-21.0 build). It powers
`GET /api/v1/businesses/lookup` on the Phase backend, which proxies to
this service (the backend never holds the multi-GB store itself).

Business data © Overture Maps Foundation, CDLA Permissive 2.0.

## Run

```bash
BIZ_LOOKUP_DB=/data/biz_lookup.db PORT=8090 python3 lookup_service.py
```

- `GET /healthz` → `{ ok, businesses, attribution }`
- `GET /lookup?q=<name>&city=&region=&country=&limit=` (limit 1–10, default 5)

Response: `{ query, matches[], ambiguous, attribution }`, plus — only
when the top match is unambiguous — `snapshotParams`, `snapshotLink` (a
ready-to-send snapshot page URL) and `draftSeed` (name, category,
website, phone, email, `socialProfiles[]`, locality/region/country) for
the mint draft.

## Matching rules

- FTS5 token-prefix match on the normalized name (+ locality when a city
  is given), ranked by exact name > brand match > same city > dataset
  confidence.
- **Brand fallback:** if the full name misses, rows whose name+brand
  covers every query token are tried (catches "Motorino North", stored
  as name "Motorino" with brand "MOTORINO North"), then progressively
  shorter name prefixes.
- **Ambiguity guardrail:** if matches span multiple localities and no
  city was given, the response sets `ambiguous: true` and omits
  `snapshotParams`/`draftSeed` — callers must ask for the city instead
  of auto-picking. Matches with dataset confidence < 0.5 carry
  `verify: true`.
- In-memory LRU cache (512 queries) and a per-IP rate limit
  (120/min); the backend adds its own 60/min limit in front.

## Deploy (production)

The store file needs a home — it is not in git and not in the Docker
image. Two shapes:

- **Free tier (no persistent disk):** split the gzipped store into
  parts, host them anywhere with direct-download URLs, and set
  `BIZ_LOOKUP_DB_URLS` to the ordered, comma-separated part URLs. On
  boot the service downloads and decompresses the store onto the
  ephemeral disk, answering `503 warming_up` until it is ready
  (`/healthz` reports the state). Every cold start or redeploy repeats
  the download, so the first lookup after a wake is slow. See
  `render.free.yaml.example`.
- **Paid (persistent disk):**

- **Render:** create a separate Web Service from this repo
  (root dir `services/business-lookup`, Docker or native Python), attach
  a 10 GB persistent disk mounted at `/data`, set
  `BIZ_LOOKUP_DB=/data/biz_lookup.db`, and copy `biz_lookup.db` onto the
  disk once (e.g. from object storage at first boot, or via the service
  shell). See `render.yaml.example`. Persistent disks need a paid plan.
- **Any VPS/container host:** mount the file anywhere and set the env
  vars above.
- Then set `BUSINESS_LOOKUP_URL=https://<this-service>` on the
  phase-backend service and redeploy it (Render auto-deploy is off, so
  deploy manually). Until that env var is set, the backend route
  answers `503 lookup_not_configured` and agents fall back to the plain
  intake flow.

## Refresh

Monthly: download the new Overture release, re-run the extraction
pipeline (builds a fresh `biz_lookup.db`), swap the file on the disk,
restart the service.
