# Phase Creator Lookup service (TikTok · YouTube · X)

Standalone, dependency-free (Python stdlib only) microservice. The Phase
backend proxies `GET /api/v1/creators/lookup?platform=<p>&username=<handle>`
to it.

Given a handle it reads the creator's **public** profile — the profile
JSON embedded in the public TikTok / YouTube page, or the FxTwitter /
VxTwitter community APIs for X — no login, no API key, no cookies.
Fields are normalized across platforms: nickname, bio, avatar, verified
flag and follower count (+ platform stats). Instagram and Facebook
serve no public profile data without a login, so they are not offered.

## Endpoints

- `GET /healthz` → `{"ok": true}`
- `GET /lookup?platform=<tiktok|youtube|x>&username=<handle>` →
  `{ query, profile, economics, snapshotParams, snapshotLink, draftSeed,
     attribution }` (platform defaults to tiktok)
  - `username` accepts `name`, `@name`, or a full profile URL.
  - 400 on an invalid handle or unsupported platform, 404 when no such
    creator exists, 502 when the platform does not respond.
  - `economics` is the suggested starting market cap from audience size
    ($10/follower, $100K floor, $50M cap) at $0.50 with a 5% float —
    an editable starting suggestion, mirrored into the snapshot link.
  - `draftSeed` pre-fills a Creator-path coin draft (name, suggested
    ticker from the handle, bio as tagline, profile URL as reference +
    platform social); `snapshotLink` renders that as the snapshot card.

## Run

```
PORT=8091 python3 creator_lookup_service.py
```

Deployed as its own free web service; the backend reaches it via
`CREATOR_LOOKUP_URL`.
