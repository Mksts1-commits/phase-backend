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
  PORT            listen port (default 8090)

Business data © Overture Maps Foundation, CDLA Permissive 2.0.
"""
import json
import os
import re
import sqlite3
import threading
import time
import unicodedata
import urllib.parse
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DB_PATH = os.environ.get("BIZ_LOOKUP_DB", "./biz_lookup.db")
PORT = int(os.environ.get("PORT", "8090"))
SNAPSHOT_BASE = "https://mksts1-commits.github.io/phase-android/app/snapshot.html"
ATTRIBUTION = "Business data © Overture Maps Foundation (CDLA Permissive 2.0)"
RATE_LIMIT_PER_MIN = 120
CACHE_MAX = 512

_db_lock = threading.Lock()
_db = None


def get_db():
    global _db
    if _db is None:
        _db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True,
                              check_same_thread=False)
        _db.row_factory = sqlite3.Row
    return _db


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
            "verify": conf < 0.5,
        })
    return out


_cache = OrderedDict()
_cache_lock = threading.Lock()


def lookup(name, city, region, country, limit):
    key = (norm(name), norm(city), (region or "").upper(),
           (country or "").upper(), limit)
    with _cache_lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key]
    matches = search(name, city, region, country, limit)
    result = {
        "query": {"q": name, "city": city, "region": region,
                  "country": country},
        "matches": matches,
        "attribution": ATTRIBUTION,
    }
    if matches:
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
        result["ambiguous"] = not unambiguous
        if unambiguous:
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
            try:
                with _db_lock:
                    n = get_db().execute("SELECT COUNT(*) FROM places").fetchone()[0]
                self._json(200, {"ok": True, "businesses": n,
                                 "attribution": ATTRIBUTION})
            except Exception as e:
                self._json(500, {"ok": False, "error": str(e)})
            return
        if parsed.path != "/lookup":
            self._json(404, {"error": "not_found"})
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
    get_db()
    print(f"business-lookup listening on :{PORT} (db={DB_PATH})")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
