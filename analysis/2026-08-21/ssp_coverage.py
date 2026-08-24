#!/usr/bin/env python
"""Can a member tier be built on suggestedSellingPrice at all?

The proposed model: a NON-MEMBER is charged the public rate (SSP), a MEMBER is
charged net + our base margin, and the gap between them is the membership. No
extra API call is needed -- the priced request already happens after we know who
is logged in, so only the `margin` VALUE changes.

That model has one hard dependency: a real SSP must exist. pricing.ts already
knows most of them are fake -- LiteAPI emits a 1.15 x net placeholder when it
has no sourced public rate, and `isRealSsp` rejects anything within 0.5% of that
ratio. Where no real SSP exists there is no public rate to charge a non-member,
so member and non-member pay the same and the tier is invisible.

So: on what share of real inventory does a real SSP exist, and how big is the
gap when it does? Everything about the tier follows from those two numbers.

    python analysis/2026-08-21/ssp_coverage.py
"""

from __future__ import annotations

import json
import statistics
import sys
import urllib.error
import urllib.request
from datetime import date, timedelta
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).resolve().parent
BASE = "https://api.liteapi.travel/v3.0"
KEY = [
    l.partition("=")[2].strip().strip("\"'")
    for l in (HERE.parent.parent / ".env.local").read_text(encoding="utf-8").splitlines()
    if l.startswith("LITEAPI_KEY")
][0]

BASE_MARGIN_PCT = 12  # src/lib/pricing.ts
MAX_MARGIN_PCT = 30
SYNTHETIC_RATIO = 1.15  # the placeholder isRealSsp() rejects

CITIES = [
    ("Austin", 30.2672, -97.7431),
    ("New Orleans", 29.9511, -90.0715),
    ("Asheville", 35.5951, -82.5515),
    ("Nashville", 36.1627, -86.7816),
]


def call(method: str, path: str, body=None, params=None):
    url = BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"X-API-Key": KEY, "Content-Type": "application/json"},
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return json.loads(r.read().decode()), None
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}: {e.read().decode()[:200]}"


import urllib.parse  # noqa: E402  (after the helper that uses it reads clearer)


def is_real_ssp(net: float, ssp: float | None) -> bool:
    if not ssp or ssp <= 0 or not net or net <= 0:
        return False
    return abs(ssp / net - SYNTHETIC_RATIO) >= 0.005


def main() -> None:
    ci = date.today() + timedelta(days=45)
    co = ci + timedelta(days=2)
    print(f"SSP coverage   {ci} -> {co}   2 adults   margin 0 (the only honest SSP)\n")

    grand = {"hotels": 0, "with_real": 0, "gaps": [], "implied": [], "capped": 0}

    for name, lat, lng in CITIES:
        d, err = call("GET", "/data/hotels", params={
            "latitude": lat, "longitude": lng, "radius": 8000, "limit": 40,
        })
        if err:
            print(f"{name}: hotel list failed {err}")
            continue
        ids = [h["id"] for h in (d.get("data") or []) if h.get("id")][:40]
        if not ids:
            print(f"{name}: no hotels")
            continue

        rates, err = call("POST", "/hotels/rates", {
            "hotelIds": ids, "occupancies": [{"adults": 2}], "currency": "USD",
            "guestNationality": "US", "checkin": ci.isoformat(), "checkout": co.isoformat(),
            "maxRatesPerHotel": 200, "roomMapping": True, "timeout": 5, "margin": 0,
        })
        if err:
            print(f"{name}: rates failed {err}")
            continue

        hotels = rates.get("data") or []
        with_real = 0
        city_gaps = []
        for entry in hotels:
            best = None  # tightest real SSP evidence for this hotel
            for rt in entry.get("roomTypes") or []:
                if rt.get("rateType") == "package":
                    continue
                net = (rt.get("offerRetailRate") or {}).get("amount")
                ssp = (rt.get("suggestedSellingPrice") or {}).get("amount")
                if not is_real_ssp(net, ssp):
                    continue
                # The member price is net + base margin; the non-member pays SSP.
                member = net * (1 + BASE_MARGIN_PCT / 100)
                if member >= ssp:
                    continue  # no member benefit here; SSP is below our own price
                gap = (ssp - member) / ssp * 100
                implied = (ssp / net - 1) * 100  # margin needed to charge SSP
                if best is None or gap > best[0]:
                    best = (gap, implied)
            if best:
                with_real += 1
                city_gaps.append(best)

        grand["hotels"] += len(hotels)
        grand["with_real"] += with_real
        for g, imp in city_gaps:
            grand["gaps"].append(g)
            grand["implied"].append(imp)
            if imp > MAX_MARGIN_PCT:
                grand["capped"] += 1

        pct = with_real / len(hotels) * 100 if hotels else 0
        med = statistics.median([g for g, _ in city_gaps]) if city_gaps else 0
        print(f"{name:<14} {len(hotels):>3} hotels priced   "
              f"{with_real:>3} with a usable public rate ({pct:>4.0f}%)   "
              f"median member gap {med:>5.1f}%")

    print("\n" + "=" * 74)
    n, w = grand["hotels"], grand["with_real"]
    print(f"{w}/{n} hotels ({w / n * 100:.0f}%) could show ANY member benefit")
    print(f"{n - w}/{n} hotels ({(n - w) / n * 100:.0f}%) would charge member and "
          f"non-member THE SAME")
    if grand["gaps"]:
        gaps = sorted(grand["gaps"])
        imps = sorted(grand["implied"])
        print(f"\nmember saving where it exists:  median {statistics.median(gaps):.1f}%   "
              f"p25 {gaps[len(gaps) // 4]:.1f}%   p75 {gaps[3 * len(gaps) // 4]:.1f}%")
        print(f"margin needed to charge SSP:    median {statistics.median(imps):.1f}%   "
              f"max {imps[-1]:.1f}%")
        print(f"hotels where that margin exceeds MAX_MARGIN_PCT={MAX_MARGIN_PCT}: "
              f"{grand['capped']}/{w}")
        print(f"  -> those non-members would be charged UNDER the public rate, so we")
        print(f"     leave ({imps[-1] - MAX_MARGIN_PCT:.0f}pp at worst) on the table unless the")
        print(f"     cap is lifted when the margin is derived FROM the public rate.")


if __name__ == "__main__":
    main()
