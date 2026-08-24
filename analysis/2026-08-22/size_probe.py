#!/usr/bin/env python
"""How much would a server-side copy of every LiteAPI rates response actually be?

Storage design needs a number, not an instinct. Measures the two calls the app
makes -- a 40-hotel search and a single-hotel detail at cap 2000 -- raw and
gzipped, and counts the offerIds in each, since an offerId-only record is the
cheap alternative to keeping the whole body.
"""
from __future__ import annotations
import gzip, json, sys, urllib.error, urllib.parse, urllib.request
from datetime import date, timedelta
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).resolve().parent
BASE = "https://api.liteapi.travel/v3.0"
KEY = [l.partition("=")[2].strip().strip("\"'")
       for l in (HERE.parent.parent / ".env.local").read_text(encoding="utf-8").splitlines()
       if l.startswith("LITEAPI_KEY")][0]

def call(method, path, body=None, params=None):
    url = BASE + path + ("?" + urllib.parse.urlencode(params) if params else "")
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body else None,
        headers={"X-API-Key": KEY, "Content-Type": "application/json"}, method=method)
    with urllib.request.urlopen(req, timeout=180) as r:
        return r.read()

ci = date.today() + timedelta(days=45)
co = ci + timedelta(days=2)

d = json.loads(call("GET", "/data/hotels",
    params={"latitude": 30.2672, "longitude": -97.7431, "radius": 8000, "limit": 40}))
ids = [h["id"] for h in (d.get("data") or []) if h.get("id")][:40]

def report(label, raw):
    obj = json.loads(raw)
    offers = []
    for e in obj.get("data") or []:
        for rt in e.get("roomTypes") or []:
            if rt.get("offerId"):
                offers.append(rt["offerId"])
    gz = len(gzip.compress(raw))
    print(f"{label:<34} raw {len(raw)/1024:>8.1f} KB   gzip {gz/1024:>7.1f} KB   "
          f"offerIds {len(offers):>5}   ids-only ~{len(''.join(offers))/1024:>6.1f} KB")
    return len(raw), gz, len(offers)

print(f"{ci} -> {co}, 2 adults, roomMapping on\n")
s_raw = call("POST", "/hotels/rates", {"hotelIds": ids, "occupancies":[{"adults":2}],
    "currency":"USD","guestNationality":"US","checkin":ci.isoformat(),"checkout":co.isoformat(),
    "maxRatesPerHotel":40,"roomMapping":True,"timeout":5,"margin":25})
sr, sg, so = report("SEARCH  40 hotels, cap 40", s_raw)

d_raw = call("POST", "/hotels/rates", {"hotelIds":["lp1b919"],"occupancies":[{"adults":2}],
    "currency":"USD","guestNationality":"US","checkin":ci.isoformat(),"checkout":co.isoformat(),
    "maxRatesPerHotel":2000,"roomMapping":True,"timeout":5,"margin":25})
dr, dg, do = report("DETAIL  1 hotel,  cap 2000", d_raw)

print("\nOne visitor journey = 1 search + 2 calls per detail page opened.")
for n in (1, 3, 10):
    tot_raw = sr + n * 2 * dr
    tot_gz = sg + n * 2 * dg
    print(f"  {n:>2} detail page(s):  raw {tot_raw/1024/1024:>5.2f} MB   gzip {tot_gz/1024:>7.1f} KB")
print("\nAt 1,000 journeys/day, keeping the FULL body:")
print(f"  raw  {(sr + 3*2*dr)*1000/1024/1024/1024:>6.2f} GB/day")
print(f"  gzip {(sg + 3*2*dg)*1000/1024/1024:>6.1f} MB/day")
