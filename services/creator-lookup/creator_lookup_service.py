#!/usr/bin/env python3
"""Phase Creator Lookup service (TikTok).

Standalone, dependency-free (Python stdlib only) microservice that the
Phase backend proxies to:

  GET /healthz               -> {"ok": true}
  GET /lookup?username=<h>   -> { query, profile, snapshotParams,
                                 snapshotLink, draftSeed, attribution }

Given a TikTok username it fetches the PUBLIC profile page on
tiktok.com (no login, no API key, no cookies) and reads the profile
JSON the page itself carries (nickname, bio, avatar, verified flag,
follower / following / heart / video counts). Nothing is stored; a
short-lived in-memory cache keeps repeat lookups gentle.

The shape mirrors the Business Lookup service on purpose: the caller
gets a ready-made `draftSeed` (Creator-path draft fields) and a
`snapshotLink` (the agent snapshot page pre-filled from the profile),
so an AI agent can autopopulate a creator's coin from a single handle.

Env:
  PORT            listen port (default 8091)
  LOOKUP_TIMEOUT  upstream fetch timeout seconds (default 10)
"""
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "8091"))
TIMEOUT = float(os.environ.get("LOOKUP_TIMEOUT", "10"))
SNAPSHOT_BASE = "https://mksts1-commits.github.io/phase-android/app/snapshot.html"
ATTRIBUTION = "Public profile data via tiktok.com"
RATE_LIMIT_PER_MIN = 120
CACHE_MAX = 512
CACHE_TTL = 600  # seconds; stats drift, keep it fresh-ish

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
HANDLE_RE = re.compile(r"^[A-Za-z0-9._]{2,24}$")
DATA_RE = re.compile(
    r'<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">(.*?)</script>',
    re.S)

_cache = OrderedDict()
_cache_lock = threading.Lock()
_rate = {}
_rate_lock = threading.Lock()


def normalize_handle(raw):
    """Accept '@name', 'name', or a full tiktok.com/@name URL."""
    if not raw:
        return None
    s = raw.strip()
    m = re.search(r"tiktok\.com/@([^/?#\s]+)", s)
    if m:
        s = m.group(1)
    s = s.lstrip("@").strip()
    return s if HANDLE_RE.match(s) else None


def suggest_ticker(username):
    t = re.sub(r"[^A-Za-z0-9]", "", username).upper()[:10]
    if len(t) < 2:
        t = (t + "TT")[:10]
    return t


def fetch_profile(username):
    """Fetch and parse the public profile page. Returns (profile, error)."""
    url = "https://www.tiktok.com/@" + urllib.parse.quote(username)
    last_err = None
    for _ in range(2):
        req = urllib.request.Request(url, headers={
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "en-US,en;q=0.9",
        })
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                html = resp.read().decode("utf-8", "replace")
            break
        except Exception as e:  # network, HTTP, timeout
            last_err = e
            html = None
    if html is None:
        return None, ("upstream_error", f"TikTok did not respond: {last_err}")
    m = DATA_RE.search(html)
    if not m:
        return None, ("not_found", "No profile data on that page.")
    try:
        data = json.loads(m.group(1))
        info = (data["__DEFAULT_SCOPE__"]["webapp.user-detail"]["userInfo"])
        user, stats = info["user"], info.get("stats") or {}
    except Exception:
        return None, ("not_found", "No profile data on that page.")
    if not user.get("uniqueId"):
        return None, ("not_found", "No such TikTok creator.")
    profile = {
        "username": user["uniqueId"],
        "nickname": user.get("nickname") or user["uniqueId"],
        "bio": user.get("signature") or "",
        "avatar": user.get("avatarLarger") or user.get("avatarMedium") or "",
        "verified": bool(user.get("verified")),
        "profileUrl": "https://www.tiktok.com/@" + user["uniqueId"],
        "stats": {
            "followers": stats.get("followerCount"),
            "following": stats.get("followingCount"),
            "hearts": stats.get("heartCount", stats.get("heart")),
            "videos": stats.get("videoCount"),
        },
    }
    return profile, None


def lookup(username):
    key = username.lower()
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < CACHE_TTL:
            _cache.move_to_end(key)
            return hit[1], None
    profile, err = fetch_profile(username)
    if err:
        return None, err
    ticker = suggest_ticker(profile["username"])
    tagline = (profile["bio"].splitlines() or [""])[0].strip()
    sp = {"name": profile["nickname"], "ticker": ticker,
          "tiktok": profile["profileUrl"], "mode": "sketch"}
    if tagline:
        sp["tagline"] = tagline
    result = {
        "query": {"username": username},
        "profile": profile,
        "snapshotParams": sp,
        "snapshotLink": SNAPSHOT_BASE + "?" + urllib.parse.urlencode(sp),
        "draftSeed": {
            "name": profile["nickname"],
            "suggestedTicker": ticker,
            "category": "Creator",
            "tagline": tagline,
            "referenceUrl": profile["profileUrl"],
            "socialProfiles": [
                {"platform": "tiktok", "url": profile["profileUrl"]}],
        },
        "attribution": ATTRIBUTION,
    }
    with _cache_lock:
        _cache[key] = (now, result)
        while len(_cache) > CACHE_MAX:
            _cache.popitem(last=False)
    return result, None


def rate_ok(ip):
    now = time.time()
    with _rate_lock:
        hits = [t for t in _rate.get(ip, []) if now - t < 60]
        if len(hits) >= RATE_LIMIT_PER_MIN:
            _rate[ip] = hits
            return False
        hits.append(now)
        _rate[ip] = hits
        return True


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, status, body):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/healthz":
            return self._json(200, {"ok": True})
        if parsed.path != "/lookup":
            return self._json(404, {"error": "no_such_route"})
        ip = self.client_address[0]
        if not rate_ok(ip):
            return self._json(429, {"error": "rate_limited"})
        qs = urllib.parse.parse_qs(parsed.query)
        username = normalize_handle((qs.get("username") or [""])[0])
        if not username:
            return self._json(400, {"error": "invalid_username",
                                    "message": "Pass ?username=<handle> (2-24 chars: letters, digits, dot, underscore)."})
        result, err = lookup(username)
        if err:
            code, msg = err
            status = 404 if code == "not_found" else 502
            return self._json(status, {"error": code, "message": msg})
        return self._json(200, result)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
