#!/usr/bin/env python
"""Test the proposed room grid against real inventory, across many hotels.

The proposal under test:

    ROOM       ~6 baseline types (tier x bed), everything else folded in
    OPTION     refundable / non-refundable
    UPSELL     breakfast, view, each a checkbox with a precomputed delta

Every section below is a question that decides whether the grid holds, not a
description of it. The two that matter most:

    * Do we need BOTH rateTypes, or can we drop `package` and lose nothing?
      Measured as: how much does the cheapest guest total in each cell move
      when package plans are removed.

    * Is an upsell a stable DELTA, or does its price depend on the room?
      A checkbox implies one number. If breakfast costs $0 on one room and
      $60 on another, it is not a checkbox, it is part of the room.

    python analysis/grid.py --city "New Orleans" --hotels 12
    python analysis/grid.py --reuse            # re-analyse the cache, no calls
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


def _key() -> str:
    for line in (HERE.parent / ".env.local").read_text(encoding="utf-8").splitlines():
        if line.startswith("LITEAPI_KEY"):
            return line.partition("=")[2].strip().strip("\"'")
    raise SystemExit("LITEAPI_KEY not found in .env.local")


def post(body: dict) -> dict:
    req = urllib.request.Request(
        f"{BASE}/hotels/rates",
        data=json.dumps(body).encode(),
        headers={"X-API-Key": _key(), "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=240) as r:
        return json.loads(r.read().decode())


# --------------------------------------------------------------- parsing
TIER = [
    (r"presidential", "Presidential Suite"),
    (r"executive\s+suite", "Executive Suite"),
    (r"junior\s+(king\s+)?suite", "Junior Suite"),
    (r"studio", "Studio Suite"),
    (r"\bparlor\b|murphy", "Parlor"),
    (r"\bsuite\b", "Suite"),
    (r"riverside|riverfront", "Riverside"),
    (r"premium|premier", "Premium"),
    (r"deluxe|superior", "Deluxe"),
    (r"standard|classic|^room\b|traditional", "Standard"),
]
BED = [
    (r"\b2\s*(queen|qn)\b|two queen", "2 Queens"),
    (r"\b2\s*doubles?\b|double room|two double", "2 Doubles"),
    (r"\b2\s*(twin|single)", "2 Twins"),
    (r"\b1\s*king\b|one king|king bed|\bking\b", "1 King"),
    (r"\b1\s*(queen|qn)\b|\bqueen\b", "1 Queen"),
    (r"\btwin\b", "Twin"),
    (r"sofa", "Sofa bed"),
]
VIEW = r"river\s*view|riverfront|riverside|city\s*view|ocean|sea\s*view|water\s*view|\bview\b|balcon|terrace"
ACCESS = r"accessib|mobility|hearing|roll-?in|visual|disabilit|\bada\b"


def match(pats, s, default):
    for pat, label in pats:
        if re.search(pat, s, re.I):
            return label
    return default


def fee_total(fees, nights):
    """Property-collected fees for the WHOLE stay. The label carries the basis."""
    total = 0.0
    for f in fees or []:
        amt = f.get("amount") or 0
        if re.search(r"per\s*(room\s*)?(per\s*)?night", f.get("description", ""), re.I):
            amt *= nights
        total += amt
    return round(total, 2)


def flatten(entries, nights) -> pd.DataFrame:
    out = []
    def first(lst):
        return (lst or [{}])[0]

    for e in entries:
        for rt in e.get("roomTypes") or []:
            for rate in rt.get("rates") or []:
                # Money lives under rate.retailRate, NOT on the rate itself.
                # Reading rate["taxesAndFees"] silently yields None and makes
                # every property fee look like zero.
                rr = rate.get("retailRate") or {}
                cancel = rate.get("cancellationPolicies") or {}
                sspd = first(rr.get("suggestedSellingPrice"))
                fees = [f for f in (rr.get("taxesAndFees") or []) if not f.get("included")]
                out.append(
                    {
                        "hotelId": e.get("hotelId"),
                        "name": rate.get("name") or "",
                        "rateType": rt.get("rateType") or "unknown",
                        "net": first(rr.get("total")).get("amount"),
                        "ssp": sspd.get("amount"),
                        "sspSource": sspd.get("source") or "",
                        "feeAtProperty": fee_total(fees, nights),
                        "feeKinds": "; ".join(sorted(f.get("description") or "(unlabelled)"
                                                     for f in fees)) or "(none)",
                        "refundable": cancel.get("refundableTag") == "RFN",
                        "boardName": rate.get("boardName") or "",
                        "board": rate.get("boardType") or "",
                    }
                )
    d = pd.DataFrame(out)
    if d.empty:
        return d
    d["guestTotal"] = (d["net"] + d["feeAtProperty"]).round(2)
    d["tier"] = d["name"].apply(lambda n: match(TIER, n, "Standard"))
    d["bed"] = d["name"].apply(lambda n: match(BED, n, "Unspecified"))
    d["roomType"] = d["tier"] + " / " + d["bed"]
    d["view"] = d["name"].str.contains(VIEW, case=False, na=False)
    d["accessible"] = d["name"].str.contains(ACCESS, case=False, na=False)
    d["breakfast"] = d["boardName"].str.contains("breakfast|bed and|half board|full board",
                                                 case=False, na=False)
    return d


def rule(t):
    print(f"\n{'=' * 84}\n{t}\n{'=' * 84}")


def delta_report(df, flag, label):
    """Is `flag` a stable add-on price, or does it depend on the room?

    Compared inside room x refundable so the only thing changing is the flag.
    """
    base = ["hotelId", "roomType", "refundable"]
    g = df.groupby(base + [flag])["guestTotal"].min().unstack(flag)
    if not {True, False} <= set(g.columns):
        print(f"{label}: not enough overlap")
        return
    g = g.dropna()
    g["delta"] = (g[True] - g[False]).round(2)
    g["pct"] = (g[True] / g[False] - 1) * 100
    if g.empty:
        print(f"{label}: no cells where both exist")
        return
    free = (g["delta"].abs() < 0.01).sum()
    cheaper = (g["delta"] < -0.01).sum()
    print(f"{label:<22} cells {len(g):>4}   median +${g['delta'].median():>7.2f} "
          f"({g['pct'].median():>+6.1f}%)   IQR ${g['delta'].quantile(.25):.2f} "
          f"to ${g['delta'].quantile(.75):.2f}")
    print(f"{'':<22} identical price in {free} cells, CHEAPER in {cheaper}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--city", default="New Orleans")
    p.add_argument("--country", default="US")
    p.add_argument("--hotels", type=int, default=12)
    p.add_argument("--checkin", default="2026-10-13")
    p.add_argument("--nights", type=int, default=2)
    p.add_argument("--cap", type=int, default=1000)
    p.add_argument("--reuse", action="store_true", help="analyse the cache, make no calls")
    args = p.parse_args()

    CACHE.mkdir(parents=True, exist_ok=True)
    checkout = (pd.Timestamp(args.checkin) + pd.Timedelta(days=args.nights)).strftime("%Y-%m-%d")
    common = {
        "occupancies": [{"adults": 2}], "currency": "USD", "guestNationality": "US",
        "checkin": args.checkin, "checkout": checkout, "margin": 0, "timeout": 12,
    }

    if not args.reuse:
        city = post({**common, "cityName": args.city, "countryCode": args.country,
                     "limit": 200, "maxRatesPerHotel": 1}).get("data") or []
        ids = [e["hotelId"] for e in city][: args.hotels]
        print(f"{len(city)} hotels in {args.city}; pulling {len(ids)} at cap {args.cap}")
        for i, hid in enumerate(ids, 1):
            try:
                data = post({**common, "hotelIds": [hid],
                             "maxRatesPerHotel": args.cap}).get("data") or []
            except Exception as exc:  # noqa: BLE001
                print(f"  {i:>2}. {hid:<12} FAILED {exc}")
                continue
            (CACHE / f"{hid}.json").write_text(json.dumps(data), encoding="utf-8")
            print(f"  {i:>2}. {hid:<12} cached")

    frames = []
    for f in sorted(CACHE.glob("*.json")):
        d = flatten(json.loads(f.read_text(encoding="utf-8")), args.nights)
        if not d.empty:
            frames.append(d)
    if not frames:
        raise SystemExit("no cached data; run without --reuse first")
    df = pd.concat(frames, ignore_index=True)

    rule(f"0. INPUT  {len(df)} plans across {df['hotelId'].nunique()} hotels")
    print(f"distinct rate names {df['name'].nunique():>6}")
    print(f"distinct roomTypes  {df['roomType'].nunique():>6}  (tier x bed)")

    rule("1. HOW FAR DOES 6 ROOM TYPES GET US?")
    for hid, g in df.groupby("hotelId"):
        vc = g["roomType"].value_counts()
        top6 = vc.head(6)
        print(f"  {hid:<12} {len(g):>5} plans, {len(vc):>3} room types, "
              f"top 6 cover {top6.sum() / len(g):5.1%} of plans   "
              f"cheapest-in-hotel captured: "
              f"{'YES' if g.loc[g['guestTotal'].idxmin(), 'roomType'] in top6.index else 'NO'}")
    vc = df["roomType"].value_counts()
    print(f"\noverall: {len(vc)} room types; top 6 = {vc.head(6).sum() / len(df):.1%} of plans")
    print(vc.head(10).to_string())

    rule("2. DO WE NEED `package`?  cheapest guest total per cell, with vs without")
    cell = ["hotelId", "roomType", "refundable", "breakfast"]
    both = df.groupby(cell)["guestTotal"].min()
    std = df[df["rateType"] == "standard"].groupby(cell)["guestTotal"].min()
    j = pd.concat([both.rename("with_pkg"), std.rename("std_only")], axis=1)
    lost = j["std_only"].isna().sum()
    j2 = j.dropna()
    j2 = j2.assign(worse=(j2["std_only"] - j2["with_pkg"]).round(2))
    j2 = j2.assign(worse_pct=(j2["std_only"] / j2["with_pkg"] - 1) * 100)
    print(f"cells total                                  {len(j)}")
    print(f"cells that DISAPPEAR without package         {lost}  ({lost / len(j):.1%})")
    print(f"cells where package holds the cheapest plan  {(j2['worse'] > 0.01).sum()}"
          f"  ({(j2['worse'] > 0.01).mean():.1%} of surviving)")
    hurt = j2[j2["worse"] > 0.01]
    if len(hurt):
        print(f"  when it does, guest pays  median +${hurt['worse'].median():.2f} "
              f"({hurt['worse_pct'].median():+.1f}%)   worst +${hurt['worse'].max():.2f}")
        print(f"  total extra across those cells: ${hurt['worse'].sum():,.2f}")
    print("\nsame question at the HOTEL level (the price on the search card):")
    h = pd.concat([df.groupby("hotelId")["guestTotal"].min().rename("with_pkg"),
                   df[df["rateType"] == "standard"].groupby("hotelId")["guestTotal"].min().rename("std_only")],
                  axis=1)
    h["worse"] = (h["std_only"] - h["with_pkg"]).round(2)
    h["worse_pct"] = (h["std_only"] / h["with_pkg"] - 1) * 100
    print(h.round(2).to_string())

    rule("3. ARE THE UPSELLS ACTUALLY STABLE DELTAS?")
    delta_report(df, "breakfast", "breakfast")
    delta_report(df, "view", "view")
    delta_report(df, "accessible", "accessible")
    g = df.groupby(["hotelId", "roomType", "breakfast"])["guestTotal"].min().unstack("refundable") \
        if False else None
    r = df.groupby(["hotelId", "roomType", "breakfast", "refundable"])["guestTotal"].min().unstack("refundable")
    if {True, False} <= set(r.columns):
        r = r.dropna()
        r["delta"] = (r[True] - r[False]).round(2)
        r["pct"] = (r[True] / r[False] - 1) * 100
        print(f"{'free cancellation':<22} cells {len(r):>4}   median +${r['delta'].median():>7.2f} "
              f"({r['pct'].median():>+6.1f}%)   IQR ${r['delta'].quantile(.25):.2f} "
              f"to ${r['delta'].quantile(.75):.2f}")
        print(f"{'':<22} identical price in {(r['delta'].abs() < 0.01).sum()} cells, "
              f"CHEAPER in {(r['delta'] < -0.01).sum()}")

    rule("4. WHAT ELSE VARIES INSIDE A SINGLE CELL?")
    v = (df.groupby(cell)
           .agg(plans=("net", "size"), netMin=("net", "min"), netMax=("net", "max"),
                feeMin=("feeAtProperty", "min"), feeMax=("feeAtProperty", "max"),
                totMin=("guestTotal", "min"), totMax=("guestTotal", "max")))
    v["netRange"] = (v["netMax"] - v["netMin"]).round(2)
    v["feeRange"] = (v["feeMax"] - v["feeMin"]).round(2)
    print(f"cells {len(v)}   median plans per cell {v['plans'].median():.0f}")
    print(f"net range within a cell     median ${v['netRange'].median():.2f}  "
          f"p90 ${v['netRange'].quantile(.9):.2f}  max ${v['netRange'].max():.2f}")
    print(f"fee range within a cell     median ${v['feeRange'].median():.2f}  "
          f"p90 ${v['feeRange'].quantile(.9):.2f}  max ${v['feeRange'].max():.2f}")
    dis = df.loc[df.groupby(cell)["net"].idxmin()].set_index(cell)["guestTotal"] != v["totMin"]
    print(f"\ncells where cheapest NET is NOT cheapest GUEST TOTAL: {dis.sum()} of {len(v)} "
          f"({dis.mean():.1%})")

    df.to_csv(HERE / "grid-plans.csv", index=False)
    print(f"\nwrote analysis/grid-plans.csv ({len(df)} plans)")


if __name__ == "__main__":
    main()
