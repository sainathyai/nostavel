#!/usr/bin/env python
"""Why do 36 of 38 Asheville hotels vanish, and what should replace that rule?

Today fetchStays pulls ONE plan per hotel (maxRatesPerHotel=1) at margin 0 and
asks marginFor() whether that single plan's suggestedSellingPrice supports a
sellable margin. If not, the hotel is dropped from search entirely.

Three things are wrong with that, and this script measures each:

  A. SAMPLE OF ONE   the cheapest plan is the most likely to be an opaque or
                     promo rate with a placeholder SSP. Judging a whole hotel
                     on it throws away hotels whose other plans have real
                     market data.
  B. GATE vs CEILING SSP is being used as a licence to sell at all. But SSP's
                     real job is "don't advertise below the public rate" — a
                     CEILING. Absent SSP we still know net cost, so we can
                     still price; we just cannot claim a saving.
  C. ONE NUMBER      margin is per-request, so one hotel needs one margin. But
                     it should be chosen from the hotel's inventory, not from
                     whichever plan happened to sort first.

Strategies compared:
  S0  current          cheapest plan's SSP must clear the floor
  S1  deeper look      any plan in the hotel with real SSP sets the margin
  S2  floor + ceiling  always sellable at BASE margin; SSP only caps it and
                       only gates the strikethrough "compare at" price

    python analysis/yield.py --city Asheville
    python analysis/yield.py --city "New Orleans" --cap 40
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

import pandas as pd

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).parent
BASE = "https://api.liteapi.travel/v3.0"
KEY = [l.partition("=")[2].strip().strip("\"'")
       for l in (HERE.parent / ".env.local").read_text(encoding="utf-8").splitlines()
       if l.startswith("LITEAPI_KEY")][0]

MIN_MARGIN, MAX_MARGIN, MIN_SAVE = 5.0, 30.0, 0.10
BASE_MARGIN = 12.0  # what we charge when there is no public rate to measure against


def post(path, body):
    req = urllib.request.Request(f"{BASE}{path}", data=json.dumps(body).encode(),
                                 headers={"X-API-Key": KEY, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=240) as r:
        return json.loads(r.read().decode())


def get(path, params):
    q = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items())
    req = urllib.request.Request(f"{BASE}{path}?{q}", headers={"X-API-Key": KEY})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode())


def real_ssp(net, ssp, source):
    """SSP is only evidence when the supplier names where it came from.
    The unsourced rows are the ssp/net == 1.15 placeholder."""
    if not ssp or not net or ssp <= 0 or net <= 0:
        return False
    if not (source or "").strip():
        return False
    return abs(ssp / net - 1.15) >= 0.005


def margin_from_ssp(net, ssp):
    """Current rule: half the spread, capped so the guest still sees 10% off."""
    ceiling = ((ssp * (1 - MIN_SAVE)) / net - 1) * 100
    if ceiling < MIN_MARGIN:
        return None
    half = ((ssp - net) / net) * 100 * 0.5
    return max(min(half, ceiling, MAX_MARGIN), MIN_MARGIN)


def plans_of(entry):
    out = []
    for rt in entry.get("roomTypes") or []:
        if rt.get("rateType") == "package":
            continue
        for rate in rt.get("rates") or []:
            rr = rate.get("retailRate") or {}
            net = ((rr.get("total") or [{}])[0]).get("amount")
            sspd = (rr.get("suggestedSellingPrice") or [{}])[0]
            if not net:
                continue
            out.append({"net": net, "ssp": sspd.get("amount"), "source": sspd.get("source") or ""})
    return out


def rule(t):
    print(f"\n{'=' * 86}\n{t}\n{'=' * 86}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--city", default="Asheville")
    p.add_argument("--lat", type=float, default=35.5951)
    p.add_argument("--lng", type=float, default=-82.5515)
    p.add_argument("--radius", type=int, default=12000)
    p.add_argument("--limit", type=int, default=40)
    p.add_argument("--checkin", default="2026-09-18")
    p.add_argument("--checkout", default="2026-09-20")
    p.add_argument("--cap", type=int, default=40)
    args = p.parse_args()

    hotels = (get("/data/hotels", {"latitude": args.lat, "longitude": args.lng,
                                   "radius": args.radius, "limit": args.limit}) or {}).get("data") or []
    ids = [h["id"] for h in hotels]
    print(f"{len(ids)} hotels near {args.city}")

    common = {"occupancies": [{"adults": 2}], "currency": "USD", "guestNationality": "US",
              "checkin": args.checkin, "checkout": args.checkout, "margin": 0, "timeout": 12}

    t0 = time.time()
    shallow = post("/hotels/rates", {**common, "hotelIds": ids, "maxRatesPerHotel": 1}).get("data") or []
    t_shallow = time.time() - t0

    t0 = time.time()
    deep = post("/hotels/rates", {**common, "hotelIds": ids, "maxRatesPerHotel": args.cap}).get("data") or []
    t_deep = time.time() - t0

    print(f"cap 1  -> {len(shallow)} hotels priced, {t_shallow:.1f}s")
    print(f"cap {args.cap} -> {len(deep)} hotels priced, {t_deep:.1f}s")

    rows = []
    for entry in deep:
        hid = entry.get("hotelId")
        ps = plans_of(entry)
        if not ps:
            continue
        ps.sort(key=lambda x: x["net"])
        cheapest = ps[0]
        evid = [x for x in ps if real_ssp(x["net"], x["ssp"], x["source"])]

        # S0 — today
        s0 = None
        if real_ssp(cheapest["net"], cheapest["ssp"], cheapest["source"]):
            s0 = margin_from_ssp(cheapest["net"], cheapest["ssp"])

        # S1 — any plan with evidence sets the margin
        s1 = None
        for x in evid:
            m = margin_from_ssp(x["net"], x["ssp"])
            if m is not None:
                s1 = m
                break

        # S2 — always sellable; SSP only caps, never gates
        if evid:
            caps = [((x["ssp"] * (1 - MIN_SAVE)) / x["net"] - 1) * 100 for x in evid]
            s2 = max(MIN_MARGIN, min(BASE_MARGIN, min(caps), MAX_MARGIN))
            compare_at = evid[0]["ssp"]
        else:
            s2, compare_at = BASE_MARGIN, None

        rows.append({"hotelId": hid, "plans": len(ps), "withEvidence": len(evid),
                     "cheapestNet": cheapest["net"],
                     "s0": s0, "s1": s1, "s2": s2,
                     "canShowCompare": compare_at is not None})

    d = pd.DataFrame(rows)

    rule("1. HOW MANY HOTELS SURVIVE EACH STRATEGY")
    n = len(d)
    for col, label in [("s0", "S0 current (cheapest plan's SSP gates)"),
                       ("s1", "S1 any plan with real SSP sets margin"),
                       ("s2", "S2 always sellable, SSP caps only")]:
        k = d[col].notna().sum()
        print(f"  {label:<42} {k:>3} of {n}  ({k / n:5.1%})")
    print(f"\n  hotels able to show a 'compare at' price:   "
          f"{d['canShowCompare'].sum()} of {n}  ({d['canShowCompare'].mean():.1%})")

    rule("2. WHY S0 LOSES THEM — evidence exists, just not on the cheapest plan")
    lost = d[d["s0"].isna()]
    print(f"hotels S0 drops: {len(lost)}")
    print(f"  ...of which DO have a plan with real SSP somewhere: "
          f"{(lost['withEvidence'] > 0).sum()}")
    print(f"  ...genuinely no evidence anywhere:                  "
          f"{(lost['withEvidence'] == 0).sum()}")
    print(f"\nplans inspected per hotel at cap {args.cap}: median {d['plans'].median():.0f}, "
          f"max {d['plans'].max()}")
    print(f"plans carrying real SSP: median {d['withEvidence'].median():.0f}")

    rule("3. WHAT WE WOULD EARN")
    for col, label in [("s0", "S0"), ("s1", "S1"), ("s2", "S2")]:
        sub = d[d[col].notna()]
        if sub.empty:
            print(f"  {label}: nothing sellable")
            continue
        rev = (sub["cheapestNet"] * sub[col] / 100).sum()
        print(f"  {label}: {len(sub):>3} hotels listed, median margin {sub[col].median():5.1f}%, "
              f"commission on cheapest room ${rev:8.2f}")

    rule("4. MARGIN SPREAD UNDER S2")
    print(d["s2"].describe().round(2).to_string())
    print(f"\nhotels capped BELOW base {BASE_MARGIN}% by a public rate: "
          f"{(d['s2'] < BASE_MARGIN - 0.01).sum()}")

    d.to_csv(HERE / "yield.csv", index=False)
    print(f"\nwrote analysis/yield.csv")


if __name__ == "__main__":
    main()
