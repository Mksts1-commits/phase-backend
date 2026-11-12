#!/usr/bin/env python3
"""Phase Creator Lookup service — social profiles (TikTok, YouTube, X).

Standalone, dependency-free (Python stdlib only) microservice that the
Phase backend proxies to:

  GET /healthz -> {"ok": true}
  GET /lookup?platform=<tiktok|youtube|x>&username=<handle>
      -> { query, profile, economics, snapshotParams, snapshotLink,
           draftSeed, attribution }

Given a handle it reads the creator's PUBLIC profile — the TikTok /
YouTube profile page's own embedded JSON, or the FxTwitter community
API for X — no login, no API key, no cookies. Returned fields are
normalized across platforms (nickname, bio, avatar, verified flag,
follower count + platform stats) so an agent can autopopulate a coin
from a single handle on any of them. Instagram and Facebook do not
serve public profile data without a login, so they are not offered;
agents seed those from the profile URL the user provides.

`economics` carries the suggested starting numbers for the snapshot
(price $0.50; market cap from audience size — $10 per follower,
$100K floor, $50M ceiling — supply = cap / price; 5% float), always
presented as an editable starting suggestion, never a valuation.

Env:
  PORT            listen port (default 8091)
  LOOKUP_TIMEOUT  upstream fetch timeout seconds (default 10)
"""
import json
import math
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
ATTRIBUTION = "Public profile data via the platform's public pages"
RATE_LIMIT_PER_MIN = 120
CACHE_MAX = 512
CACHE_TTL = 600  # seconds; stats drift, keep it fresh-ish
PLATFORMS = ("tiktok", "youtube", "x")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
HANDLE_RE = re.compile(r"^[A-Za-z0-9._-]{2,30}$")
TT_DATA_RE = re.compile(
    r'<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">(.*?)</script>',
    re.S)

_cache = OrderedDict()
_cache_lock = threading.Lock()
_rate = {}
_rate_lock = threading.Lock()


def fetch_text(url):
    last = None
    for _ in range(2):
        req = urllib.request.Request(url, headers={
            "User-Agent": UA, "Accept": "*/*",
            "Accept-Language": "en-US,en;q=0.9"})
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                return resp.read().decode("utf-8", "replace")
        except Exception as e:
            last = e
    raise last


def fetch_json(url):
    return json.loads(fetch_text(url))


def suggest_ticker(username):
    t = re.sub(r"[^A-Za-z0-9]", "", username).upper()[:10]
    if len(t) < 2:
        t = (t + "TT")[:10]
    return t


def economics_for(followers):
    f = int(followers or 0)
    cap = max(100_000, min(50_000_000, f * 10))
    if cap >= 1_000:
        digits = 10 ** int(math.floor(math.log10(cap))) // 10
        cap = int(round(cap / digits) * digits)
    return {
        "price": 0.5,
        "marketCap": cap,
        "supply": cap * 2,
        "floatPct": 5,
        "basis": ("Starting suggestion from audience size "
                  "($10 per follower, $100K floor, $50M cap). "
                  "The creator sets their own numbers at mint."),
    }


# ---------------------------------------------------------------- TikTok
def normalize_tiktok(raw):
    if not raw:
        return None
    s = raw.strip()
    m = re.search(r"tiktok\.com/@([^/?#\s]+)", s)
    if m:
        s = m.group(1)
    s = s.lstrip("@").strip()
    return s if re.match(r"^[A-Za-z0-9._]{2,24}$", s) else None


def fetch_tiktok(username):
    html = fetch_text("https://www.tiktok.com/@"
                      + urllib.parse.quote(username))
    m = TT_DATA_RE.search(html)
    if not m:
        return None, ("not_found", "No profile data on that page.")
    try:
        data = json.loads(m.group(1))
        info = data["__DEFAULT_SCOPE__"]["webapp.user-detail"]["userInfo"]
        user, stats = info["user"], info.get("stats") or {}
    except Exception:
        return None, ("not_found", "No profile data on that page.")
    if not user.get("uniqueId"):
        return None, ("not_found", "No such TikTok creator.")
    return {
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
    }, None


# ---------------------------------------------------------------- YouTube
def normalize_youtube(raw):
    if not raw:
        return None
    s = raw.strip()
    m = re.search(r"youtube\.com/(?:@|channel/)([^/?#\s]+)", s)
    if m:
        s = m.group(1)
    return s if HANDLE_RE.match(s.lstrip("@")) or s.startswith("UC") else None


def parse_count_label(text):
    """'30.7 million' / '1.2 thousand' / '1K' / '950' -> int."""
    if not text:
        return None
    t = text.replace(",", "").strip().lower()
    m = re.match(r"([\d.]+)\s*(million|thousand|k|m)?", t)
    if not m:
        return None
    val = float(m.group(1))
    mult = {"million": 1_000_000, "m": 1_000_000,
            "thousand": 1_000, "k": 1_000}.get(m.group(2), 1)
    return int(val * mult)


def fetch_youtube(handle):
    if handle.startswith("UC") and len(handle) > 12:
        url = "https://www.youtube.com/channel/" + handle
    else:
        url = "https://www.youtube.com/@" + urllib.parse.quote(handle.lstrip("@"))
    html = fetch_text(url)
    m = re.search(r"var ytInitialData = (\{.*?\});</script>", html, re.S)
    if not m:
        return None, ("not_found", "No channel data on that page.")
    try:
        data = json.loads(m.group(1))
        md = data["metadata"]["channelMetadataRenderer"]
    except Exception:
        return None, ("not_found", "No such YouTube channel.")
    raw = m.group(1)
    subs = re.search(r'"([\d.]+ (?:million|thousand) subscribers|[\d.,]+ subscribers)"', raw)
    vids = re.search(r'"([\d.,]+[KM]? videos)"', raw)
    vanity = md.get("vanityChannelUrl") or ""
    username = vanity.rstrip("/").split("@")[-1] if "@" in vanity else handle.lstrip("@")
    thumbs = (md.get("avatar") or {}).get("thumbnails") or []
    return {
        "username": username,
        "nickname": md.get("title") or username,
        "bio": md.get("description") or "",
        "avatar": thumbs[-1]["url"] if thumbs else "",
        "verified": "BADGE_STYLE_TYPE_VERIFIED" in raw,
        "profileUrl": "https://www.youtube.com/@" + username,
        "stats": {
            "followers": parse_count_label(subs.group(1)) if subs else None,
            "following": None,
            "hearts": None,
            "videos": parse_count_label(vids.group(1)) if vids else None,
            "approximate": True,  # YouTube rounds public counts
        },
    }, None


# ---------------------------------------------------------------- X
def normalize_x(raw):
    if not raw:
        return None
    s = raw.strip()
    m = re.search(r"(?:x|twitter)\.com/([^/?#\s]+)", s)
    if m:
        s = m.group(1)
    s = s.lstrip("@").strip()
    return s if HANDLE_RE.match(s) else None


def fetch_x(handle):
    # FxTwitter first (richest fields); VxTwitter as fallback — FxTwitter
    # intermittently 404s accounts it served minutes earlier.
    try:
        d = fetch_json("https://api.fxtwitter.com/"
                       + urllib.parse.quote(handle))
        user = d.get("user") if isinstance(d, dict) else None
    except Exception:
        user = None
    if user:
        ver = user.get("verification") or {}
        return {
            "username": user.get("screen_name") or handle,
            "nickname": user.get("name") or handle,
            "bio": user.get("description") or "",
            "avatar": (user.get("avatar_url") or "").replace("_normal", "_400x400"),
            "verified": bool(ver.get("verified")),
            "profileUrl": "https://x.com/" + (user.get("screen_name") or handle),
            "stats": {
                "followers": user.get("followers"),
                "following": user.get("following"),
                "hearts": user.get("likes"),
                "videos": None,
                "posts": user.get("tweets"),
            },
        }, None
    try:
        v = fetch_json("https://api.vxtwitter.com/"
                       + urllib.parse.quote(handle))
    except Exception as e:
        if isinstance(e, urllib.error.HTTPError) and e.code in (403, 404):
            return None, ("not_found", "No such X account.")
        return None, ("upstream_error", f"X lookup did not respond: {e}")
    if not isinstance(v, dict) or not v.get("screen_name"):
        return None, ("not_found", "No such X account.")
    return {
        "username": v.get("screen_name") or handle,
        "nickname": v.get("name") or handle,
        "bio": v.get("description") or "",
        "avatar": (v.get("profile_image_url") or "").replace(
            "_normal", "_400x400"),
        "verified": bool(v.get("verified")),
        "profileUrl": "https://x.com/" + (v.get("screen_name") or handle),
        "stats": {
            "followers": v.get("followers_count"),
            "following": v.get("following_count"),
            "hearts": v.get("likes_count"),
            "videos": None,
            "posts": v.get("tweet_count"),
        },
    }, None


FETCHERS = {"tiktok": (normalize_tiktok, fetch_tiktok),
            "youtube": (normalize_youtube, fetch_youtube),
            "x": (normalize_x, fetch_x)}


def lookup(platform, raw_handle):
    normalize, fetcher = FETCHERS[platform]
    handle = normalize(raw_handle)
    if not handle:
        return None, ("invalid_username",
                      f"Pass a valid {platform} handle or profile URL.")
    key = (platform, handle.lower())
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < CACHE_TTL:
            _cache.move_to_end(key)
            return hit[1], None
    try:
        profile, err = fetcher(handle)
    except Exception as e:
        return None, ("upstream_error", f"{platform} did not respond: {e}")
    if err:
        return None, err
    profile = dict(profile)
    profile["platform"] = platform
    ticker = suggest_ticker(profile["username"])
    tagline = (profile["bio"].splitlines() or [""])[0].strip()
    econ = economics_for((profile.get("stats") or {}).get("followers"))
    sp = {"name": profile["nickname"], "ticker": ticker,
          platform: profile["profileUrl"], "mode": "sketch",
          "price": str(econ["price"]), "cap": str(econ["marketCap"]),
          "supply": str(econ["supply"])}
    if tagline:
        sp["tagline"] = tagline
    result = {
        "query": {"platform": platform, "username": handle},
        "profile": profile,
        "economics": econ,
        "snapshotParams": sp,
        "snapshotLink": SNAPSHOT_BASE + "?" + urllib.parse.urlencode(sp),
        "draftSeed": {
            "name": profile["nickname"],
            "suggestedTicker": ticker,
            "category": "Creator",
            "tagline": tagline,
            "referenceUrl": profile["profileUrl"],
            "socialProfiles": [
                {"platform": platform, "url": profile["profileUrl"]}],
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
        platform = ((qs.get("platform") or ["tiktok"])[0]).lower()
        if platform not in PLATFORMS:
            return self._json(400, {"error": "unsupported_platform",
                                    "message": f"platform must be one of {', '.join(PLATFORMS)} (Instagram/Facebook serve no public profile data without a login)."})
        result, err = lookup(platform, (qs.get("username") or [""])[0])
        if err:
            code, msg = err
            status = {"not_found": 404, "invalid_username": 400}.get(code, 502)
            return self._json(status, {"error": code, "message": msg})
        return self._json(200, result)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
