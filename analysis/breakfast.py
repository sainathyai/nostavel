#!/usr/bin/env python
"""Is breakfast a fixed add-on price, or does it move with the room?

The previous pass compared medians across cells and mixed package rates in,
which confounded "breakfast costs money" with "package rates are cheaper".
This one is stricter on every axis:

  * package excluded         room-only product, per the current scope
  * synthetic SSP excluded   keep only plans where retailRate carries a source
  * EXACT room match         the two plans must share the same rate `name`,
                             so nothing differs except the board

If breakfast is a real add-on it should show up as a delta that is constant
within a hotel and divisible into a sane per-person-per-night figure.

    python analysis/breakfast.py
    python analysis/breakfast.py --adults 2 --nights 2
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pandas as pd

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).parent


def rule(t):
    print(f"\n{'=' * 84}\n{t}\n{'=' * 84}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--adults", type=int, default=2)
    p.add_argument("--nights", type=int, default=2)
    p.add_argument("--keep-package", action="store_true")
    args = p.parse_args()

    df = pd.read_csv(HERE / "grid-plans.csv")
    start = len(df)

    if not args.keep_package:
        df = df[df["rateType"] == "standard"]
    # A populated `source` is the reliable marker of real market data; the
    # blank-source rows are the ssp/net == 1.15 placeholder.
    df = df[df["sspSource"].notna() & (df["sspSource"].astype(str).str.strip() != "")]

    rule(f"FILTERED  {start} -> {len(df)} plans "
         f"({df['hotelId'].nunique()} hotels, sources: "
         f"{', '.join(sorted(df['sspSource'].unique()))})")

    # ---------------------------------------------- exact same room, board differs
    rule("1. EXACT ROOM MATCH  (identical rate name, board differs)")
    key = ["hotelId", "name", "refundable"]
    g = df.groupby(key + ["breakfast"])["net"].min().unstack("breakfast")
    if not {True, False} <= set(g.columns):
        print("no room name appears both with and without breakfast")
        exact = pd.DataFrame()
    else:
        exact = g.dropna().rename(columns={False: "roomOnly", True: "withBreakfast"})
        exact["delta"] = (exact["withBreakfast"] - exact["roomOnly"]).round(2)
        print(f"rate names offering both boards: {len(exact)}")
        if len(exact):
            print(exact["delta"].describe().round(2).to_string())

    # The exact-name join is strict and may be thin, so also match on the
    # collapsed room identity, which is what the UI will actually group on.
    rule("2. UI-LEVEL MATCH  (same hotel + roomType + refundable)")
    key2 = ["hotelId", "roomType", "refundable"]
    g2 = df.groupby(key2 + ["breakfast"])["net"].min().unstack("breakfast")
    pairs = pd.DataFrame()
    if {True, False} <= set(g2.columns):
        pairs = g2.dropna().rename(columns={False: "roomOnly", True: "withBreakfast"})
        pairs["delta"] = (pairs["withBreakfast"] - pairs["roomOnly"]).round(2)
        pairs["perPersonNight"] = (pairs["delta"] / (args.adults * args.nights)).round(2)
        print(f"cells with both boards: {len(pairs)}")
        print(f"  negative delta (breakfast cheaper): {(pairs['delta'] < -0.01).sum()}")
        print(f"  zero:                               {(pairs['delta'].abs() <= 0.01).sum()}")
        print(f"  positive:                           {(pairs['delta'] > 0.01).sum()}")

    if pairs.empty:
        raise SystemExit("nothing to compare")

    # ------------------------------------------- is the delta fixed PER HOTEL?
    rule("3. IS THE DELTA CONSTANT WITHIN A HOTEL?")
    print("If breakfast is a fixed add-on, every room in a hotel shares one delta.\n")
    per = pairs.groupby("hotelId")["delta"].agg(
        cells="size", lo="min", median="median", hi="max", std="std", distinct="nunique")
    per["range"] = (per["hi"] - per["lo"]).round(2)
    per["perPersonNight"] = (per["median"] / (args.adults * args.nights)).round(2)
    print(per.round(2).to_string())

    fixed = per[(per["range"] <= 1.0) & (per["cells"] > 1)]
    print(f"\nhotels where the delta is effectively ONE number (range <= $1): "
          f"{len(fixed)} of {len(per)}")

    rule("4. DOES IT LOOK LIKE A PER-PERSON PRICE?")
    print(f"assuming {args.adults} adults x {args.nights} nights = "
          f"{args.adults * args.nights} breakfasts\n")
    pos = pairs[pairs["delta"] > 0.01]
    print(f"positive-delta cells: {len(pos)}")
    if len(pos):
        print(pos["perPersonNight"].describe().round(2).to_string())
        print("\nmost common per-person-per-night values:")
        print(pos["perPersonNight"].round(0).value_counts().head(10).to_string())

    rule("5. THE CELLS WHERE BREAKFAST IS CHEAPER")
    neg = pairs[pairs["delta"] < -0.01].sort_values("delta")
    print(f"{len(neg)} cells. If these survive package removal and the source "
          f"filter, they are real inverted pricing, not a rate-mix artefact.\n")
    print(neg.round(2).head(15).to_string())

    rule("6. VERDICT INPUTS")
    print(f"exact-name pairs           {len(exact)}")
    print(f"ui-level pairs             {len(pairs)}")
    print(f"share positive             {(pairs['delta'] > 0.01).mean():.1%}")
    print(f"share zero or negative     {(pairs['delta'] <= 0.01).mean():.1%}")
    print(f"median positive delta      ${pos['delta'].median() if len(pos) else 0:.2f}")
    print(f"hotels w/ single delta     {len(fixed)} of {len(per)}")

    pairs.to_csv(HERE / "breakfast-pairs.csv")
    print(f"\nwrote analysis/breakfast-pairs.csv ({len(pairs)} cells)")


if __name__ == "__main__":
    main()
