#!/usr/bin/env python3
"""Phase Business Lookup service.

A tiny, dependency-free HTTP service over the SQLite FTS5 store built from
Overture Maps Places (see extract pipeline in the Phase-Business-Lookup spec).

  GET /healthz
  GET /lookup?q=Aladdin+Shawarma&city=Vaughan&region=ON&country=CA&limit=5

Response: { query, matches[], snapshotParams, snapshotLink, draftSeed,
            ambiguous, attribution }
`snapshotParams` / `draftSeed` describe the top match and are only present
when the top match is unambiguous (single match, a city was given, all
matches share one locality, or the top match is an exact name match) — the
caller must never auto-pick between same-name businesses in different
cities.

Env:
  BIZ_LOOKUP_DB   path to biz_lookup.db (default ./biz_lookup.db)
  BIZ_LOOKUP_DB_URLS  comma-separated part URLs; when the store file is
                  absent it is downloaded (parts concatenate into one
                  gzip stream) and decompressed at boot — the free-tier
                  bootstrap, since free disks are ephemeral
  PORT            listen port (default 8090)

Business data © Overture Maps Foundation, CDLA Permissive 2.0.
"""
import gzip
import json
import os
import re
import sqlite3
import threading
import time
import unicodedata
import urllib.parse
import urllib.request
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DB_PATH = os.environ.get("BIZ_LOOKUP_DB", "./biz_lookup.db")
# Free-tier bootstrap: when the store file is absent, it is downloaded at
# boot from BIZ_LOOKUP_DB_URLS — a comma-separated, ordered list of URLs
# whose bytes concatenate into ONE gzip stream of the .db file (the file
# split into parts). Any plain direct-download host works (object
# storage, a public Drive/GitHub/HF link, another server).
DB_URLS = [u.strip() for u in os.environ.get("BIZ_LOOKUP_DB_URLS", "").split(",") if u.strip()]
PORT = int(os.environ.get("PORT", "8090"))
SNAPSHOT_BASE = "https://mksts1-commits.github.io/phase-android/app/snapshot.html"
ATTRIBUTION = "Business data © Overture Maps Foundation (CDLA Permissive 2.0)"
OSM_ATTRIBUTION = "Business data © OpenStreetMap contributors (via Photon)"
PHOTON_URL = "https://photon.komoot.io/api/"
PHOTON_TIMEOUT = 6  # seconds; the fallback must stay inside the proxy budget
RATE_LIMIT_PER_MIN = 120
CACHE_MAX = 512

_db_lock = threading.Lock()
_db = None

STATE = {"ready": False, "error": None, "progress": "starting", "count": None}


def _count_async():
    # Exact row count, computed once in the background on a private
    # connection with a real page cache. A COUNT(*) on the 6 GB places
    # table through the request path's 4 MB cache takes minutes and,
    # under the db lock, blocks every lookup and health check behind it.
    try:
        conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True,
                               check_same_thread=False)
        conn.execute("PRAGMA cache_size = -64000")
        STATE["count"] = conn.execute(
            "SELECT COUNT(*) FROM places").fetchone()[0]
        conn.close()
        print(f"store count ready: {STATE['count']}", flush=True)
    except Exception as e:
        print(f"store count failed (non-fatal): {e}", flush=True)


def get_db():
    global _db
    if _db is None:
        _db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True,
                              check_same_thread=False)
        _db.row_factory = sqlite3.Row
        # Keep the footprint small enough for free-tier instances.
        _db.execute("PRAGMA cache_size = -4000")
        _db.execute("PRAGMA mmap_size = 0")
        _db.execute("PRAGMA temp_store = MEMORY")
    return _db


def _download_store():
    """Fetch the store parts, gunzip them into place, mark ready."""
    tmp = DB_PATH + ".tmp"
    try:
        STATE["progress"] = "downloading store"
        with open(tmp, "wb") as out:
            gz = gzip.GzipFile(fileobj=_PartReader(DB_URLS), mode="rb")
            while True:
                chunk = gz.read(1 << 20)
                if not chunk:
                    break
                out.write(chunk)
        os.replace(tmp, DB_PATH)
        get_db().execute("SELECT 1 FROM places LIMIT 1").fetchone()
        STATE["ready"] = True
        STATE["progress"] = "ready"
        threading.Thread(target=_count_async, daemon=True).start()
        print("store bootstrap complete", flush=True)
    except Exception as e:
        STATE["error"] = str(e)
        STATE["progress"] = "failed"
        print(f"store bootstrap failed: {e}", flush=True)


class _PartReader:
    """File-like that streams the concatenation of the part URLs."""

    def __init__(self, urls):
        self.urls = urls
        self.idx = 0
        self.resp = None
        self.buf = b""

    def _open_next(self):
        if self.idx >= len(self.urls):
            self.resp = None
            return False
        url = self.urls[self.idx]
        self.idx += 1
        last_err = None
        for _ in range(3):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "phase-lookup/1.0"})
                self.resp = urllib.request.urlopen(req, timeout=120)
                return True
            except Exception as e:  # retry transient fetch failures
                last_err = e
                time.sleep(2)
        raise RuntimeError(f"download failed for part {self.idx}: {last_err}")

    def read(self, n=-1):
        if n is None or n < 0:
            n = 1 << 20
        while len(self.buf) < n:
            if self.resp is None and not self._open_next():
                break
            chunk = self.resp.read(n - len(self.buf))
            if chunk:
                self.buf += chunk
            else:
                self.resp = None
        out, self.buf = self.buf[:n], self.buf[n:]
        return out


def ensure_store():
    if os.path.exists(DB_PATH) and os.path.getsize(DB_PATH) > 0:
        STATE["ready"] = True
        STATE["progress"] = "ready"
        threading.Thread(target=_count_async, daemon=True).start()
        return
    if not DB_URLS:
        STATE["error"] = "store file missing and BIZ_LOOKUP_DB_URLS not set"
        STATE["progress"] = "no_store"
        return
    threading.Thread(target=_download_store, daemon=True).start()


def norm(s):
    if not s:
        return ""
    s = unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore").decode()
    s = s.lower().replace("&", " and ")
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def fts_query(name_tokens, city_tokens):
    parts = [f'name_norm:"{t}"*' for t in name_tokens]
    parts += [f'locality_norm:"{t}"*' for t in city_tokens]
    return " AND ".join(parts)


def fetch(name_tokens, city_tokens, region, country, limit):
    sql = ("SELECT p.* FROM places p JOIN places_fts f ON f.rowid = p.rowid "
           "WHERE places_fts MATCH ?")
    params = [fts_query(name_tokens, city_tokens)]
    if country:
        sql += " AND p.country = ?"
        params.append(country.upper())
    if region:
        sql += " AND upper(p.region) = ?"
        params.append(region.upper())
    sql += " LIMIT ?"
    params.append(limit)
    with _db_lock:
        return [dict(r) for r in get_db().execute(sql, params).fetchall()]


def brand_covers(row, tokens):
    """True when every query token appears in the row's name+brand words.
    Catches 'Motorino North': stored name is 'Motorino', brand carries
    'MOTORINO North'."""
    words = set(norm(row.get("name")).split()) | set(norm(row.get("brand")).split())
    return all(t in words for t in tokens)


def search(name, city, region, country, limit):
    tokens = norm(name).split()
    if not tokens:
        return []
    city_tokens = norm(city).split() if city else []
    want = max(limit * 4, 20)
    via = {}

    rows = fetch(tokens, city_tokens, region, country, want)
    for r in rows:
        via[r["id"]] = "name"

    if not rows and len(tokens) > 1:
        # Brand / variant fallback: anchor on the first token, then keep
        # only rows whose name+brand covers every query token.
        anchored = fetch(tokens[:1], city_tokens, region, country, want)
        rows = [r for r in anchored if brand_covers(r, tokens)]
        for r in rows:
            via[r["id"]] = "brand"
        if not rows:
            # Progressive prefix: drop trailing tokens ("… North", "… Inc").
            for k in range(len(tokens) - 1, 0, -1):
                rows = fetch(tokens[:k], city_tokens, region, country, want)
                if rows:
                    for r in rows:
                        via[r["id"]] = "name-prefix"
                    break

    name_norm_full = norm(name)
    city_norm = norm(city)

    def score(r):
        conf = float(r.get("confidence") or 0)
        return (
            1 if r.get("name_norm") == name_norm_full else 0,
            1 if via.get(r["id"]) == "brand" else 0,
            1 if city_norm and r.get("locality_norm") == city_norm else 0,
            conf,
        )

    rows.sort(key=score, reverse=True)
    out = []
    for r in rows[:limit]:
        try:
            socials = json.loads(r["socials"]) if r.get("socials") else {}
        except Exception:
            socials = {}
        conf = float(r.get("confidence") or 0)
        out.append({
            "sourceId": r.get("id"),
            "name": r.get("name"),
            "category": r.get("category"),
            "address": r.get("address"),
            "locality": r.get("locality"),
            "region": r.get("region"),
            "postcode": r.get("postcode"),
            "country": r.get("country"),
            "phone": r.get("phone"),
            "website": r.get("website"),
            "email": r.get("email"),
            "socials": socials,
            "brand": r.get("brand") or None,
            "confidence": conf,
            "lat": float(r["lat"]) if r.get("lat") else None,
            "lon": float(r["lon"]) if r.get("lon") else None,
            "matchedVia": via.get(r["id"], "name"),
            "verify": conf < 0.5 or (via.get(r["id"]) == "name-prefix"
                                     and r.get("name_norm") != name_norm_full),
        })
    return out


_cache = OrderedDict()
_cache_lock = threading.Lock()


def photon_search(name, city, region, country, limit):
    """Fallback over OpenStreetMap data via the public Photon service.

    Used only when the local store has no match (the store is Canada;
    Photon is global). Returns (matches, seedable). `seedable` is False
    when a city was requested but no result sits in it — same-name
    businesses in other cities are shown as candidates but never
    auto-picked for the snapshot/draft seed, the same guardrail the
    store search follows. Contact fields are usually absent in OSM;
    the minting agent enriches them with live research.
    """
    q = name + (f", {city}" if city else "")
    params = {"q": q, "limit": str(min(max(limit * 2, 5), 10)), "lang": "en"}
    req = urllib.request.Request(
        PHOTON_URL + "?" + urllib.parse.urlencode(params),
        headers={"User-Agent": "phase-lookup/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=PHOTON_TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
    except Exception:
        return [], True
    want_country = (country or "").upper()
    want_city = norm(city)
    out, in_city = [], []
    for feat in data.get("features") or []:
        p = feat.get("properties") or {}
        if not p.get("name"):
            continue
        cc = (p.get("countrycode") or "").upper()
        if want_country and cc and cc != want_country:
            continue
        coords = (feat.get("geometry") or {}).get("coordinates") or []
        addr = " ".join(x for x in [p.get("housenumber"), p.get("street")] if x)
        m = {
            "sourceId": f"osm:{p.get('osm_type')}/{p.get('osm_id')}",
            "name": p.get("name"),
            "category": (p.get("osm_value") or "").replace("_", " ") or None,
            "address": addr or None,
            "locality": p.get("city") or p.get("locality") or p.get("town"),
            "region": p.get("state"),
            "postcode": p.get("postcode"),
            "country": cc or None,
            "phone": p.get("phone"),
            "website": p.get("website"),
            "email": None,
            "socials": {},
            "brand": None,
            "confidence": 0.65,
            "lat": coords[1] if len(coords) > 1 else None,
            "lon": coords[0] if coords else None,
            "matchedVia": "photon",
            "verify": False,
        }
        out.append(m)
        if want_city and norm(m.get("locality")) == want_city:
            in_city.append(m)
    if want_city:
        if in_city:
            return in_city[:limit], True
        for m in out:
            m["verify"] = True
            m["confidence"] = 0.4
        return out[:limit], False
    return out[:limit], True


def lookup(name, city, region, country, limit):
    key = (norm(name), norm(city), (region or "").upper(),
           (country or "").upper(), limit)
    with _cache_lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key]
    matches = search(name, city, region, country, limit)
    source = "overture"
    seedable = True
    if not matches:
        matches, seedable = photon_search(name, city, region, country, limit)
        if matches:
            source = "photon"
    result = {
        "query": {"q": name, "city": city, "region": region,
                  "country": country},
        "matches": matches,
        "source": source,
        "attribution": OSM_ATTRIBUTION if source == "photon" else ATTRIBUTION,
    }
    if matches and not seedable:
        result["ambiguous"] = True
    if matches and seedable:
        top = matches[0]
        # Unambiguous only when: a single match, a city was given, every
        # match sits in the top match's locality, or the top match is an
        # exact name match AND all other matches share its locality.
        # Same-name businesses in different cities are never auto-picked.
        top_locality = norm(top.get("locality"))
        same_locality = all(norm(m.get("locality")) == top_locality
                            for m in matches)
        unambiguous = (
            len(matches) == 1
            or bool(city)
            or same_locality
        )
        # A partial-token (name-prefix) hit that is not the exact name is
        # a candidate, not an identification — never seed a snapshot from
        # it. (The progressive prefix fallback can degrade a query like
        # "In-N-Out Burger" to a single generic token and surface
        # unrelated local businesses at full dataset confidence.)
        solid = (top.get("matchedVia") != "name-prefix"
                 or norm(top.get("name")) == norm(name))
        result["ambiguous"] = not (unambiguous and solid)
        if unambiguous and solid:
            sp = {"name": top["name"], "mode": "sketch"}
            if top.get("website"):
                sp["website"] = top["website"]
            for k, v in (top.get("socials") or {}).items():
                if v:
                    sp[k] = v
            result["snapshotParams"] = sp
            result["snapshotLink"] = (SNAPSHOT_BASE + "?" +
                                      urllib.parse.urlencode(sp))
            result["draftSeed"] = {
                "name": top["name"],
                "category": top.get("category"),
                "website": top.get("website"),
                "phone": top.get("phone"),
                "email": top.get("email"),
                "socialProfiles": [
                    {"platform": k, "url": v}
                    for k, v in (top.get("socials") or {}).items() if v
                ],
                "locality": top.get("locality"),
                "region": top.get("region"),
                "country": top.get("country"),
            }
    with _cache_lock:
        _cache[key] = result
        while len(_cache) > CACHE_MAX:
            _cache.popitem(last=False)
    return result


_rate = {}
_rate_lock = threading.Lock()


def rate_ok(ip):
    now = time.time()
    with _rate_lock:
        bucket = [t for t in _rate.get(ip, []) if now - t < 60]
        if len(bucket) >= RATE_LIMIT_PER_MIN:
            _rate[ip] = bucket
            return False
        bucket.append(now)
        _rate[ip] = bucket
        return True


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _json(self, status, body):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        if parsed.path == "/healthz":
            if not STATE["ready"]:
                self._json(200, {"ok": False, "state": STATE["progress"],
                                 "error": STATE["error"],
                                 "attribution": ATTRIBUTION})
                return
            # O(1) by design: never query the store from a health check.
            self._json(200, {"ok": True, "businesses": STATE.get("count"),
                             "attribution": ATTRIBUTION})
            return
        if parsed.path != "/lookup":
            self._json(404, {"error": "not_found"})
            return
        if not STATE["ready"]:
            self._json(503, {"error": "warming_up",
                             "message": "Lookup store is still loading; try again shortly.",
                             "state": STATE["progress"]})
            return
        ip = (self.headers.get("x-forwarded-for") or
              self.client_address[0]).split(",")[0].strip()
        if not rate_ok(ip):
            self._json(429, {"error": "rate_limited",
                             "message": "Too many lookups; slow down."})
            return
        q = (qs.get("q") or [""])[0].strip()
        if not q:
            self._json(400, {"error": "missing_q",
                             "message": "Query parameter `q` (business name) is required."})
            return
        city = (qs.get("city") or [""])[0].strip()
        region = (qs.get("region") or [""])[0].strip()
        country = (qs.get("country") or [""])[0].strip()
        try:
            limit = int((qs.get("limit") or ["5"])[0])
        except ValueError:
            limit = 5
        limit = max(1, min(limit, 10))
        try:
            self._json(200, lookup(q, city, region, country, limit))
        except Exception as e:
            self._json(500, {"error": "lookup_failed", "message": str(e)})


if __name__ == "__main__":
    ensure_store()
    print(f"business-lookup listening on :{PORT} (db={DB_PATH})", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
