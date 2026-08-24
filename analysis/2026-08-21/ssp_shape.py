#!/usr/bin/env python
"""Is a missing public rate NULL, or the 1.15 placeholder? Both, and in what mix?

pricing.ts rejects an SSP two different ways and the distinction matters for the
no-SSP fallback margin, so count them separately rather than lumping both into
"no real SSP".
"""
from __future__ import annotations
import collections, json, sys, urllib.error, urllib.parse, urllib.request
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
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return json.loads(r.read().decode()), None
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}"

ci = date.today() + timedelta(days=46)
plans = collections.Counter()
sources = collections.Counter()
hotels = collections.Counter()

for name, lat, lng in [("Austin",30.2672,-97.7431), ("New Orleans",29.9511,-90.0715),
                       ("Nashville",36.1627,-86.7816)]:
    d, err = call("GET", "/data/hotels", params={"latitude":lat,"longitude":lng,"radius":8000,"limit":40})
    if err: continue
    ids = [h["id"] for h in (d.get("data") or []) if h.get("id")][:40]
    r, err = call("POST", "/hotels/rates", {"hotelIds":ids,"occupancies":[{"adults":2}],
        "currency":"USD","guestNationality":"US","checkin":ci.isoformat(),
        "checkout":(ci+timedelta(days=2)).isoformat(),"maxRatesPerHotel":200,
        "roomMapping":True,"timeout":5,"margin":0})
    if err: continue
    for entry in r.get("data") or []:
        kinds = set()
        for rt in entry.get("roomTypes") or []:
            if rt.get("rateType") == "package": continue
            net = (rt.get("offerRetailRate") or {}).get("amount")
            sspobj = rt.get("suggestedSellingPrice") or {}
            ssp = sspobj.get("amount")
            src = (sspobj.get("source") or "").strip()
            if not net: continue
            if ssp is None: k = "field absent"
            elif ssp <= 0: k = "zero"
            elif abs(ssp/net - 1.15) < 0.005: k = "1.15x placeholder"
            else: k = "REAL"
            plans[k] += 1
            kinds.add(k)
            if k == "REAL": sources[src or "(no source string)"] += 1
        hotels["REAL" if "REAL" in kinds else (sorted(kinds)[0] if kinds else "no plans")] += 1

tot = sum(plans.values())
print(f"{tot} standard plans across 3 cities\n")
print("PER PLAN:")
for k, v in plans.most_common():
    print(f"  {k:<20} {v:>5}  {v/tot*100:>5.1f}%")
th = sum(hotels.values())
print(f"\nPER HOTEL (best plan in the hotel), {th} hotels:")
for k, v in hotels.most_common():
    print(f"  {k:<20} {v:>5}  {v/th*100:>5.1f}%")
print("\n`source` on the REAL ones:")
for k, v in sources.most_common(6):
    print(f"  {k:<28} {v}")
