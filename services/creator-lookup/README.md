# Phase Creator Lookup service (TikTok)

Standalone, dependency-free (Python stdlib only) microservice. The Phase
backend proxies `GET /api/v1/creators/lookup?username=<handle>` to it.

Given a TikTok username it fetches the **public** profile page on
tiktok.com — no login, no API key, no cookies — and reads the profile
JSON the page itself carries: nickname, bio, avatar, verified flag, and
follower / following / heart / video counts.

## Endpoints

- `GET /healthz` → `{"ok": true}`
- `GET /lookup?username=<handle>` → `{ query, profile, snapshotParams,
  snapshotLink, draftSeed, attribution }`
  - `username` accepts `name`, `@name`, or a full `tiktok.com/@name` URL.
  - 400 on an invalid handle, 404 when no such creator exists,
    502 when TikTok does not respond.
  - `draftSeed` pre-fills a Creator-path coin draft (name, suggested
    ticker from the handle, bio as tagline, profile URL as reference +
    TikTok social); `snapshotLink` renders that as the snapshot card.

## Run

```
PORT=8091 python3 creator_lookup_service.py
```

Results are cached in memory for 10 minutes (stats drift; repeat
lookups stay gentle). Per-IP limit: 120/min. Nothing is persisted.

## Deploy (Render free tier)

See `render.yaml.example` — a tiny free web service; cold starts are
fast (no store to download, unlike the Business Lookup service).
Set `CREATOR_LOOKUP_URL=https://<this-service>.onrender.com` on the
phase-backend service and redeploy it to activate the public endpoint.
