#!/usr/bin/env python
"""Pull the raw rate objects behind a few breakfast-cheaper pairs so a human
can eyeball what's actually different between them: name, promotions,
remarks, cancellation, board — not just the two prices.

Uses the already-cached raw JSON from analysis/raw/grid/*.json, no API call.

    python analysis/breakfast_examples.py
    python analysis/breakfast_examples.py --hotel lp1b0f4 --room "Suite / 2 Queens"
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import pandas as pd

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).parent
CACHE = HERE / "raw" / "grid"

TIER = [
    (r"presidential", "Presidential Suite"), (r"executive\s+suite", "Executive Suite"),
    (r"junior\s+(king\s+)?suite", "Junior Suite"), (r"studio", "Studio Suite"),
    (r"\bparlor\b|murphy", "Parlor"), (r"\bsuite\b", "Suite"),
    (r"riverside|riverfront", "Riverside"), (r"premium|premier", "Premium"),
    (r"deluxe|superior", "Deluxe"), (r"standard|classic|^room\b|traditional", "Standard"),
]
BED = [
    (r"\b2\s*(queen|qn)\b|two queen", "2 Queens"), (r"\b2\s*doubles?\b|double room|two double", "2 Doubles"),
    (r"\b2\s*(twin|single)", "2 Twins"), (r"\b1\s*king\b|one king|king bed|\bking\b", "1 King"),
    (r"\b1\s*(queen|qn)\b|\bqueen\b", "1 Queen"), (r"\btwin\b", "Twin"), (r"sofa", "Sofa bed"),
]


def match(pats, s, default):
    for pat, label in pats:
        if re.search(pat, s, re.I):
            return label
    return default


def room_type(name):
    return match(TIER, name, "Standard") + " / " + match(BED, name, "Unspecified")


def first(lst):
    return (lst or [{}])[0]


def describe(hotel_id, name, rt, rate):
    rr = rate.get("retailRate") or {}
    cancel = rate.get("cancellationPolicies") or {}
    ssp = first(rr.get("suggestedSellingPrice"))
    fees = rr.get("taxesAndFees") or []
    return {
        "hotelId": hotel_id,
        "rateType": rt.get("rateType"),
        "name": rate.get("name"),
        "boardName": rate.get("boardName"),
        "boardType": rate.get("boardType"),
        "net": first(rr.get("total")).get("amount"),
        "ssp": ssp.get("amount"),
        "sspSource": ssp.get("source"),
        "refundable": (cancel.get("refundableTag") == "RFN"),
        "cancelPolicy": cancel.get("refundableTag"),
        "rateId": rate.get("rateId"),
        "priceType": rate.get("priceType"),
        "promotions": rate.get("promotions"),
        "perks": rate.get("perks"),
        "remarks": rate.get("remarks"),
        "commission": rate.get("commission"),
        "providerCommission": rate.get("providerCommission"),
        "paymentTypes": rate.get("paymentTypes"),
        "feesIncluded": [f for f in fees if f.get("included")],
        "feesAtProperty": [f for f in fees if not f.get("included")],
    }


def print_rate(d):
    print(f"  rateId          {d['rateId']}")
    print(f"  name            {d['name']!r}")
    print(f"  boardName       {d['boardName']}   (boardType {d['boardType']})")
    print(f"  net             ${d['net']:.2f}   ssp ${d['ssp']}  (source: {d['sspSource']!r})")
    print(f"  refundable      {d['cancelPolicy']}")
    print(f"  priceType       {d['priceType']}")
    print(f"  commission      {d['commission']}   providerCommission {d['providerCommission']}")
    print(f"  paymentTypes    {d['paymentTypes']}")
    print(f"  promotions      {d['promotions']}")
    print(f"  perks           {d['perks']}")
    print(f"  remarks         {d['remarks']}")
    for f in d["feesIncluded"]:
        print(f"  fee(included)   {f.get('description')!r} = {f.get('amount')} {f.get('currency')}")
    for f in d["feesAtProperty"]:
        print(f"  fee(at prop.)   {f.get('description')!r} = {f.get('amount')} {f.get('currency')}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--hotel", default=None)
    p.add_argument("--room", default=None)
    p.add_argument("--n", type=int, default=4, help="number of hotel/room examples to show")
    args = p.parse_args()

    files = sorted(CACHE.glob(f"{args.hotel}.json" if args.hotel else "*.json"))
    if not files:
        raise SystemExit(f"no cache found in {CACHE}; run grid.py first")

    shown = 0
    for f in files:
        if shown >= args.n and not args.hotel:
            break
        hotel_id = f.stem
        entries = json.loads(f.read_text(encoding="utf-8"))
        # collect standard, real-SSP rates only, grouped by roomType+refundable
        by_cell: dict[tuple, dict[bool, list[dict]]] = {}
        for e in entries:
            for rt in e.get("roomTypes") or []:
                if rt.get("rateType") != "standard":
                    continue
                for rate in rt.get("rates") or []:
                    rr = rate.get("retailRate") or {}
                    ssp = first(rr.get("suggestedSellingPrice"))
                    if not ssp.get("source"):
                        continue
                    name = rate.get("name") or ""
                    rtype = room_type(name)
                    if args.room and rtype != args.room:
                        continue
                    cancel = rate.get("cancellationPolicies") or {}
                    refundable = cancel.get("refundableTag") == "RFN"
                    board = (rate.get("boardName") or "").lower()
                    has_bf = "breakfast" in board
                    cell = (rtype, refundable)
                    by_cell.setdefault(cell, {}).setdefault(has_bf, []).append(
                        describe(hotel_id, name, rt, rate))

        for (rtype, refundable), boards in by_cell.items():
            if True not in boards or False not in boards:
                continue
            cheapest_bf = min(boards[True], key=lambda d: d["net"])
            cheapest_no = min(boards[False], key=lambda d: d["net"])
            if cheapest_bf["net"] >= cheapest_no["net"]:
                continue  # only show the counter-intuitive ones
            shown += 1
            print(f"\n{'=' * 90}")
            print(f"{hotel_id}  |  {rtype}  |  refundable={refundable}")
            print(f"breakfast ${cheapest_bf['net']:.2f}  vs  room-only ${cheapest_no['net']:.2f}"
                  f"   (breakfast is ${cheapest_no['net'] - cheapest_bf['net']:.2f} CHEAPER)")
            print(f"{'-' * 90}")
            print("WITH BREAKFAST:")
            print_rate(cheapest_bf)
            print("\nROOM ONLY:")
            print_rate(cheapest_no)
            if shown >= args.n:
                break
        if shown >= args.n:
            break

    if shown == 0:
        print("no counter-intuitive pairs found with these filters")


if __name__ == "__main__":
    main()
