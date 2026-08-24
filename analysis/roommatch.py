#!/usr/bin/env python
"""POC: replace the tier/bed regex with LiteAPI's Room Match API.

Reference catalog is fixed at 10 booking-room-type options (Standard / King /
Queen / 2 Queens, each with a View and Accessible variant where it makes
sense). For every hotel we already have cached, pull the distinct SUPPLIER
room names (standard rateType only - package stays excluded per the current
scope) and ask /rooms/match which of the 10 each one is.

Two things this has to prove before it's worth wiring into the app:

  1. COVERAGE   what fraction of real rooms map at all, and at what
                 confidence, since a bucket nobody maps into is dead weight
                 and a low-confidence match risks calling a room "King" that
                 isn't.
  2. AGREEMENT   does it actually correct the cases the regex got wrong
                 (the "2 ROOM SUITE" vs "Two Queens Suite" mixup from the
                 breakfast pass), or produce new ones of its own.

Breakfast is no longer priced as an addon: each plan is standalone, tagged
with its own board. A room's cheapest listing is whichever raw plan (BI or
RO) has the lowest net + property fee, full stop.

    python analysis/roommatch.py                 # all cached hotels
    python analysis/roommatch.py --hotel lp1b919  # one hotel, verbose
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.request
from pathlib import Path

import pandas as pd

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).parent
CACHE = HERE / "raw" / "grid"
BASE = "https://api.liteapi.travel/v3.0"
NIGHTS = 2

CATALOG = [
    {"id": "std", "name": "Standard Room"},
    {"id": "king", "name": "Standard Room, 1 King Bed"},
    {"id": "queen", "name": "Standard Room, 1 Queen Bed"},
    {"id": "2queen", "name": "Standard Room, 2 Queen Beds"},
    {"id": "king_view", "name": "Standard Room, 1 King Bed, View"},
    {"id": "queen_view", "name": "Standard Room, 1 Queen Bed, View"},
    {"id": "2queen_view", "name": "Standard Room, 2 Queen Beds, View"},
    {"id": "king_acc", "name": "Standard Room, 1 King Bed, Accessible"},
    {"id": "queen_acc", "name": "Standard Room, 1 Queen Bed, Accessible"},
    {"id": "2queen_acc", "name": "Standard Room, 2 Queen Beds, Accessible"},
    # Catch-all so a real price never goes missing just because the room is a
    # suite, family room, or anything else outside the 10 standard buckets.
    {"id": "other", "name": "Other Room Type"},
]


def _key() -> str:
    for line in (HERE.parent / ".env.local").read_text(encoding="utf-8").splitlines():
        if line.startswith("LITEAPI_KEY"):
            return line.partition("=")[2].strip().strip("\"'")
    raise SystemExit("LITEAPI_KEY not found in .env.local")


def post(path: str, body: dict) -> dict:
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=json.dumps(body).encode(),
        headers={"X-API-Key": _key(), "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode())


def fee_total(fees):
    total = 0.0
    for f in fees or []:
        amt = f.get("amount") or 0
        if re.search(r"per\s*(room\s*)?(per\s*)?night", f.get("description", ""), re.I):
            amt *= NIGHTS
        total += amt
    return round(total, 2)


def first(lst):
    return (lst or [{}])[0]


def flatten_hotel(hotel_id: str, entries: list[dict]) -> pd.DataFrame:
    rows = []
    for e in entries:
        for rt in e.get("roomTypes") or []:
            if rt.get("rateType") != "standard":
                continue
            for rate in rt.get("rates") or []:
                rr = rate.get("retailRate") or {}
                cancel = rate.get("cancellationPolicies") or {}
                ssp = first(rr.get("suggestedSellingPrice"))
                fees = [f for f in (rr.get("taxesAndFees") or []) if not f.get("included")]
                rows.append(
                    {
                        "hotelId": hotel_id,
                        "name": rate.get("name") or "",
                        "net": first(rr.get("total")).get("amount"),
                        "ssp": ssp.get("amount"),
                        "sspSource": ssp.get("source") or "",
                        "feeAtProperty": fee_total(fees),
                        "refundable": cancel.get("refundableTag") == "RFN",
                        "boardName": rate.get("boardName") or "",
                        "breakfast": "breakfast" in (rate.get("boardName") or "").lower(),
                    }
                )
    d = pd.DataFrame(rows)
    if not d.empty:
        d["guestTotal"] = (d["net"] + d["feeAtProperty"]).round(2)
    return d


def rule(t):
    print(f"\n{'=' * 92}\n{t}\n{'=' * 92}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--hotel", default=None)
    p.add_argument("--threshold", type=float, default=0.5)
    p.add_argument("--topk", type=int, default=3)
    args = p.parse_args()

    files = sorted(CACHE.glob(f"{args.hotel}.json" if args.hotel else "*.json"))
    if not files:
        raise SystemExit(f"no cache in {CACHE}; run grid.py first")

    all_plans = []
    all_matches = []
    for f in files:
        hotel_id = f.stem
        entries = json.loads(f.read_text(encoding="utf-8"))
        plans = flatten_hotel(hotel_id, entries)
        if plans.empty:
            continue
        all_plans.append(plans)

        names = sorted(plans["name"].unique())
        suppliers = [{"i": i, "name": n} for i, n in enumerate(names)]
        resp = post(
            "/rooms/match",
            {
                "hotelId": hotel_id,
                "references": CATALOG,
                "suppliers": suppliers,
                "threshold": args.threshold,
                "topK": args.topk,
            },
        )
        results = (resp.get("data") or {}).get("results") or []
        for r in results:
            # Live response shape differs from the published doc: fields are
            # supplierName/referenceId/referenceName/score, not name/id/
            # scoreCalibrated.
            sel = r.get("selected")
            all_matches.append(
                {
                    "hotelId": hotel_id,
                    "supplierName": r.get("supplierName"),
                    "status": r.get("status"),
                    "matchedId": (sel or {}).get("referenceId"),
                    "matchedName": (sel or {}).get("referenceName"),
                    "score": (sel or {}).get("score"),
                    "candidates": json.dumps(
                        [(c.get("referenceName"), round(c.get("score", 0), 3))
                         for c in (r.get("candidates") or [])[:3]]
                    ),
                }
            )
        print(f"{hotel_id:<12} {len(names):>3} distinct room names -> "
              f"{sum(1 for r in results if r.get('status') == 'mapped')} mapped, "
              f"{sum(1 for r in results if r.get('status') != 'mapped')} unmapped")

    plans = pd.concat(all_plans, ignore_index=True)
    matches = pd.DataFrame(all_matches)
    df = plans.merge(matches, left_on=["hotelId", "name"], right_on=["hotelId", "supplierName"], how="left")

    rule("1. COVERAGE")
    print(f"distinct supplier room names   {len(matches)}")
    print(f"mapped                         {(matches['status'] == 'mapped').sum()} "
          f"({(matches['status'] == 'mapped').mean():.1%})")
    print(f"not_mapped                     {(matches['status'] != 'mapped').sum()}")
    m = matches[matches["status"] == "mapped"]
    print(f"\nconfidence on mapped rows:")
    print(m["score"].describe().round(3).to_string())
    print(f"\nscore < 0.7 (mapped but shaky): {(m['score'] < 0.7).sum()} of {len(m)}")

    rule("2. WHICH CATALOG BUCKETS ACTUALLY GET USED")
    print(m["matchedName"].value_counts().to_string())
    unused = set(c["name"] for c in CATALOG) - set(m["matchedName"].unique())
    if unused:
        print(f"\nnever matched: {sorted(unused)}")

    rule("3. PLAN-LEVEL COVERAGE  (does the price-bearing data map, not just names)")
    print(f"total plans              {len(df)}")
    print(f"plans on a mapped room    {(df['status'] == 'mapped').sum()} "
          f"({(df['status'] == 'mapped').mean():.1%})")
    cheapest_per_hotel = df.loc[df.groupby("hotelId")["guestTotal"].idxmin()]
    print(f"\nis the CHEAPEST plan in each hotel on a mapped room?")
    print(cheapest_per_hotel[["hotelId", "name", "matchedName", "status", "guestTotal"]]
          .to_string(index=False))

    rule("4. LOW-CONFIDENCE AND UNMAPPED EXAMPLES  (what a human should sanity check)")
    shaky = matches[(matches["status"] != "mapped") | (matches["score"] < 0.7)]
    for _, r in shaky.head(20).iterrows():
        matched = repr(r["matchedName"]) if pd.notna(r["matchedName"]) else ""
        print(f"  [{r['hotelId']}] {r['supplierName']!r:<45} -> "
              f"{r['status']:<10} {matched:<40} "
              f"score={r['score']}  candidates={r['candidates']}")

    rule("5. FINAL BOOKING GRID  (catalog name shown, cheapest per bucket)")
    mapped_df = df[df["status"] == "mapped"].copy()
    grid = (
        mapped_df.groupby(["hotelId", "matchedName", "refundable", "breakfast"])["guestTotal"]
        .min()
        .reset_index()
        .sort_values(["hotelId", "guestTotal"])
    )
    print(f"rows in final grid across {df['hotelId'].nunique()} hotels: {len(grid)}")
    print(f"(vs {len(plans)} raw plans -> {len(grid) / len(plans):.1%} of original volume)")
    print(grid.head(30).to_string(index=False))

    df.to_csv(HERE / "roommatch-plans.csv", index=False)
    matches.to_csv(HERE / "roommatch-results.csv", index=False)
    grid.to_csv(HERE / "roommatch-grid.csv", index=False)
    print(f"\nwrote roommatch-plans.csv, roommatch-results.csv, roommatch-grid.csv")


if __name__ == "__main__":
    main()
