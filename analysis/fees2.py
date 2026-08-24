#!/usr/bin/env python
"""Which of the three bases does each charge actually follow?

fees.py showed the 2-night -> 4-night amount ratio clustering near 1.48, which
is neither flat (per-stay) nor doubled (per-night). 1.48 is what you get when
the charge is a PERCENTAGE of a room rate that itself only rose 1.48x, because
nightly rates differ by day of week. So the basis test has to normalise by the
room rate instead of by nights.

For every fee line item we compute:

    pct       = amount / net            stable across stays  -> PERCENTAGE
    perNight  = amount / nights         stable across stays  -> PER NIGHT
    amount                              stable across stays  -> PER STAY

and score which hypothesis holds, per (hotel, description). This matters
because it decides both the arithmetic (do we multiply by nights?) and the
wording (a percentage levy is plausibly a tax; a flat $40 is not).

    python analysis/fees2.py --ids lp225d01,lpda0d1
    python analysis/fees2.py --city Asheville --hotels 10
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

import pandas as pd

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).parent
BASE = "https://api.liteapi.travel/v3.0"


def _key() -> str:
    for line in (HERE.parent / ".env.local").read_text(encoding="utf-8").splitlines():
        if line.startswith("LITEAPI_KEY"):
            return line.partition("=")[2].strip().strip("\"'")
    raise SystemExit("LITEAPI_KEY not found in .env.local")


KEY = _key()


def post(path, body):
    req = urllib.request.Request(
        f"{BASE}{path}", data=json.dumps(body).encode(),
        headers={"X-API-Key": KEY, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read().decode())


def pull(ids, checkin, checkout, nights, cap):
    data = post("/hotels/rates", {
        "hotelIds": ids, "occupancies": [{"adults": 2}], "currency": "USD",
        "guestNationality": "US", "checkin": checkin, "checkout": checkout,
        "maxRatesPerHotel": cap, "margin": 0, "timeout": 12,
    }).get("data") or []
    rows = []
    for e in data:
        for rt in e.get("roomTypes") or []:
            for rate in rt.get("rates") or []:
                rr = rate.get("retailRate") or {}
                net = ((rr.get("total") or [{}])[0]).get("amount")
                if not net:
                    continue
                for f in rr.get("taxesAndFees") or []:
                    amt = f.get("amount") or 0
                    rows.append({
                        "hotelId": e.get("hotelId"),
                        "nights": nights,
                        "room": rate.get("name") or "",
                        "desc": (f.get("description") or "(empty)").strip() or "(empty)",
                        "included": bool(f.get("included")),
                        "amount": amt,
                        "net": net,
                        "pct": round(amt / net * 100, 4) if net else None,
                        "perNight": round(amt / nights, 4),
                    })
    return rows


def rule(t):
    print(f"\n{'=' * 88}\n{t}\n{'=' * 88}")


def stability(series):
    """Coefficient of variation; low means this hypothesis holds."""
    m = series.mean()
    return (series.std() / m) if m else float("inf")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--ids", default=None)
    p.add_argument("--city", default="Asheville")
    p.add_argument("--country", default="US")
    p.add_argument("--hotels", type=int, default=10)
    p.add_argument("--checkin", default="2026-09-18")
    p.add_argument("--cap", type=int, default=60)
    args = p.parse_args()

    if args.ids:
        ids = [x.strip() for x in args.ids.split(",") if x.strip()]
    else:
        found = post("/hotels/rates", {
            "cityName": args.city, "countryCode": args.country, "limit": 200,
            "occupancies": [{"adults": 2}], "currency": "USD", "guestNationality": "US",
            "checkin": args.checkin, "checkout": "2026-09-20",
            "maxRatesPerHotel": 1, "margin": 0, "timeout": 12}).get("data") or []
        ids = [e["hotelId"] for e in found][: args.hotels]
        print(f"profiling {len(ids)} hotels in {args.city}")

    # Three stay lengths so a hypothesis has to survive more than one comparison.
    plans = [("2026-09-20", 2), ("2026-09-22", 4), ("2026-09-25", 7)]
    rows = []
    for checkout, nights in plans:
        rows += pull(ids, args.checkin, checkout, nights, args.cap)
    d = pd.DataFrame(rows)
    if d.empty:
        raise SystemExit("no data")
    print(f"{len(d)} fee line items across stays of {[n for _, n in plans]} nights")

    rule("1. ROOM RATE ITSELF — confirms why the naive night-ratio looked like 1.48")
    nr = d.groupby(["hotelId", "nights"])["net"].min().unstack("nights")
    nr["4/2"] = (nr[4] / nr[2]).round(3)
    nr["7/2"] = (nr[7] / nr[2]).round(3)
    print(nr.round(2).to_string())
    print("\nIf a charge were a flat % of the room rate, its own ratio would match")
    print("these columns exactly — not 1.0 (per stay) and not 2.0 / 3.5 (per night).")

    rule("2. WHICH BASIS FITS?  per (hotel, description), lower CV wins")
    out = []
    for (hid, desc, inc), g in d.groupby(["hotelId", "desc", "included"]):
        if g["nights"].nunique() < 2:
            continue
        # Compare like with like: cheapest plan at each stay length.
        cheap = g.loc[g.groupby("nights")["net"].idxmin()]
        cv_amt = stability(cheap["amount"])
        cv_pct = stability(cheap["pct"])
        cv_pn = stability(cheap["perNight"])
        best = min([("PER STAY", cv_amt), ("PERCENTAGE", cv_pct), ("PER NIGHT", cv_pn)],
                   key=lambda x: x[1])
        out.append({
            "hotelId": hid, "desc": desc, "included": inc,
            "cv_perStay": round(cv_amt, 4), "cv_pct": round(cv_pct, 4),
            "cv_perNight": round(cv_pn, 4),
            "basis": best[0], "confidence": round(1 - best[1], 3),
            "medPct": round(cheap["pct"].median(), 2),
            "medAmt": round(cheap["amount"].median(), 2),
        })
    res = pd.DataFrame(out).sort_values(["included", "desc"])
    print(res.to_string(index=False))

    rule("3. VERDICT BY DESCRIPTION")
    for inc in (False, True):
        side = res[res["included"] == inc]
        if side.empty:
            continue
        label = "DUE AT PROPERTY" if not inc else "INCLUDED IN PRICE"
        print(f"\n--- {label} ---")
        for desc, g in side.groupby("desc"):
            votes = g["basis"].value_counts()
            win = votes.index[0]
            print(f"  {desc!r:<20} {win:<12} ({votes[win]}/{len(g)} hotels agree)"
                  f"   median {g['medPct'].median():.2f}% of room / ${g['medAmt'].median():.2f}")

    rule("4. THE WORDING TEST")
    print("A charge that is a stable PERCENTAGE of the room rate behaves like a tax.")
    print("A charge that is a FLAT amount regardless of rate or nights is a fee and")
    print("must not be called a tax.\n")
    for _, r in res.iterrows():
        if not r["included"]:
            safe = "tax-like (percentage)" if r["basis"] == "PERCENTAGE" else \
                   "FEE — must NOT say 'tax'" if r["basis"] == "PER STAY" else \
                   "per-night fee — MUST multiply by nights"
            print(f"  {r['hotelId']:<12} {r['desc']!r:<18} {r['basis']:<12} -> {safe}")

    d.to_csv(HERE / "fees2-raw.csv", index=False)
    res.to_csv(HERE / "fees2-basis.csv", index=False)
    print(f"\nwrote analysis/fees2-raw.csv, analysis/fees2-basis.csv")


if __name__ == "__main__":
    main()
