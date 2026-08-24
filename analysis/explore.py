#!/usr/bin/env python
"""Explore LiteAPI rate plans for a single hotel.

    python analysis/explore.py fetch --hotel lp1b919 --checkin 2026-10-13 --nights 2
    python analysis/explore.py summary
    python analysis/explore.py rooms
    python analysis/explore.py room "Standard"
    python analysis/explore.py outliers
    python analysis/explore.py fees
    python analysis/explore.py options
    python analysis/explore.py export

Global filters, usable with any command:

    --sane            drop plans priced at or above their own SSP (we could
                      never sell those, and they are most of the weird tail)
    --max-total N     drop plans whose guest total exceeds N
    --room SUBSTR     restrict to room types matching a substring
    --refundable / --non-refundable
    --breakfast / --no-breakfast

Everything reads a local cache, so only `fetch` touches the network. Edit the
TIER / BED tables below to change how rooms are grouped — that is the main
thing worth tuning by hand.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

import pandas as pd

# The Windows console is cp1252 by default and raises on any non-ASCII
# character we print. Force UTF-8 rather than restricting what we can output.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).parent
RAW = HERE / "raw"
RAW.mkdir(parents=True, exist_ok=True)
CACHE = RAW / "explore-cache.json"

pd.set_option("display.width", 200)
pd.set_option("display.max_columns", 40)
pd.set_option("display.max_colwidth", 46)


# --------------------------------------------------------------- room grouping
# The single most useful thing to tweak. Order matters: first match wins, so
# the most specific product word must come first.
TIER = [
    (r"presidential", "Presidential"),
    (r"executive\s+suite", "Executive Suite"),
    (r"junior\s+(king\s+)?suite", "Junior Suite"),
    (r"studio", "Studio Suite"),
    (r"\bparlor\b|murphy", "Parlor"),
    (r"\bsuite\b", "Suite"),
    (r"riverside|riverfront", "Riverside"),
    (r"premium", "Premium"),
    (r"deluxe", "Deluxe"),
    (r"standard|^room\b", "Standard"),
]
BED = [
    (r"\b2\s*(queen|qn)\b|two queen", "2 Queens"),
    (r"\b2\s*doubles?\b|double room", "2 Doubles"),
    (r"\b1\s*king\b|one king|king", "1 King"),
    (r"\b1\s*(queen|qn)\b|queen", "1 Queen"),
    (r"\btwin\b", "Twin"),
    (r"sofa", "Sofa bed"),
]


def _match(patterns, text, default):
    for pattern, label in patterns:
        if re.search(pattern, text, re.I):
            return label
    return default


# -------------------------------------------------------------------- fetching
def _env(key: str) -> str:
    """Read a value out of the app's .env.local."""
    path = HERE.parent / ".env.local"
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip().startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        if k.strip() == key:
            return v.strip().strip("\"'")
    raise SystemExit(f"{key} not found in {path}")


def fetch(hotel: str, checkin: str, nights: int, adults: int, cap: int) -> None:
    checkout = (pd.Timestamp(checkin) + pd.Timedelta(days=nights)).strftime("%Y-%m-%d")
    body = {
        "hotelIds": [hotel],
        "occupancies": [{"adults": adults}],
        "currency": "USD",
        "guestNationality": "US",
        "checkin": checkin,
        "checkout": checkout,
        # High on purpose. Rates come back sorted CHEAPEST FIRST, so any cap
        # truncates the expensive end — which is where every refundable plan
        # lives. At the default of 200 this hotel showed 1% refundable; the
        # true figure is 60%.
        "maxRatesPerHotel": cap,
        "margin": 0,  # the only setting where suggestedSellingPrice is real
        "timeout": 12,
    }
    req = urllib.request.Request(
        f"{os.environ.get('LITEAPI_BASE_URL', 'https://api.liteapi.travel/v3.0')}/hotels/rates",
        data=json.dumps(body).encode(),
        headers={"X-API-Key": _env("LITEAPI_KEY"), "Content-Type": "application/json"},
    )
    print(f"fetching {hotel} {checkin} -> {checkout} ({nights}n, {adults} adults, cap {cap}) ...")
    with urllib.request.urlopen(req, timeout=180) as resp:
        payload = json.loads(resp.read().decode())

    plans = (payload.get("data") or [{}])[0].get("roomTypes") or []
    slim = []
    for rt in plans:
        rate = (rt.get("rates") or [{}])[0]
        taxes = (rate.get("retailRate") or {}).get("taxesAndFees") or []
        cancel = rate.get("cancellationPolicies") or {}
        slim.append(
            {
                "name": " ".join((rate.get("name") or "").split()),
                "board": rate.get("boardType", ""),
                "boardName": rate.get("boardName", ""),
                "refundable": cancel.get("refundableTag", ""),
                "cancelBy": (cancel.get("cancelPolicyInfos") or [{}])[0].get("cancelTime"),
                "cancelTiers": len(cancel.get("cancelPolicyInfos") or []),
                "rateType": rt.get("rateType", ""),
                "rateCode": rate.get("rateCode", ""),
                "price": (rt.get("offerRetailRate") or {}).get("amount"),
                "ssp": (rt.get("suggestedSellingPrice") or {}).get("amount"),
                "sspSource": (rt.get("suggestedSellingPrice") or {}).get("source", ""),
                "feesOut": [
                    {"d": t.get("description", ""), "a": t.get("amount", 0)}
                    for t in taxes
                    if t.get("included") is False
                ],
                "taxIncluded": sum(t.get("amount", 0) for t in taxes if t.get("included") is True),
            }
        )

    CACHE.write_text(
        json.dumps({"hotel": hotel, "checkin": checkin, "nights": nights, "adults": adults, "plans": slim}),
        encoding="utf-8",
    )
    print(f"cached {len(slim)} plans -> {CACHE.relative_to(HERE.parent)}")
    if len(slim) == cap:
        print(f"WARNING: returned exactly {cap} = the cap. Re-run with a higher --cap.")


# ------------------------------------------------------------------- loading
def load(args) -> pd.DataFrame:
    if not CACHE.exists():
        raise SystemExit("no cache — run `fetch` first")
    blob = json.loads(CACHE.read_text(encoding="utf-8"))
    nights = blob["nights"]
    df = pd.DataFrame(blob["plans"])
    if df.empty:
        raise SystemExit("cache is empty")

    def fee_for_stay(fees):
        """Property-collected fees for the WHOLE stay.

        The label carries the basis: 'Resort Fee Per Room Per Night' at $70.50
        is $141 over two nights. Summing once understates the guest total by
        the largest single amount in the data.
        """
        total = 0.0
        for f in fees:
            amount = f.get("a") or 0
            if re.search(r"per\s*(room\s*)?(per\s*)?night", f.get("d", ""), re.I):
                amount *= nights
            total += amount
        return round(total, 2)

    df["feeAtProperty"] = df["feesOut"].apply(fee_for_stay)
    df["feeKinds"] = df["feesOut"].apply(lambda fs: "; ".join(sorted(f["d"] for f in fs)) or "(none)")
    df["guestTotal"] = (df["price"] + df["feeAtProperty"]).round(2)
    df["perNight"] = (df["guestTotal"] / nights).round(2)

    df["tier"] = df["name"].apply(lambda n: _match(TIER, n, "Standard"))
    df["bed"] = df["name"].apply(lambda n: _match(BED, n, "Unspecified"))
    df["roomType"] = df["tier"] + " / " + df["bed"]

    df["riverView"] = df["name"].str.contains(r"river\s*view|riverfront|riverside", case=False, na=False)
    df["accessible"] = df["name"].str.contains(
        r"accessib|mobility|hearing|roll-?in|visual|disabilit", case=False, na=False
    )
    df["breakfast"] = df["board"].str.upper().ne("RO") | df["boardName"].str.contains(
        "breakfast", case=False, na=False
    )
    df["option"] = df["refundable"].map({"RFN": "Free cancellation", "NRFN": "Non-refundable"}).fillna("?")
    # How far the public rate sits above our cost. Below ~1.1 there is no room
    # to take a margin and still show the guest a saving.
    df["spread"] = (df["ssp"] / df["price"]).round(3)

    df.attrs["nights"] = nights
    df.attrs["hotel"] = blob["hotel"]

    before = len(df)
    if args.sane:
        df = df[df["price"] < df["ssp"]]
    if args.max_total is not None:
        df = df[df["guestTotal"] <= args.max_total]
    if args.room:
        df = df[df["roomType"].str.contains(args.room, case=False, na=False)]
    if args.refundable:
        df = df[df["refundable"] == "RFN"]
    if args.non_refundable:
        df = df[df["refundable"] == "NRFN"]
    if args.breakfast:
        df = df[df["breakfast"]]
    if args.no_breakfast:
        df = df[~df["breakfast"]]
    if len(df) != before:
        print(f"[filters: {before} -> {len(df)} plans]\n")
    if df.empty:
        raise SystemExit("filters removed everything")
    return df


def rule(title: str) -> None:
    print(f"\n{'-' * 100}\n{title}\n{'-' * 100}")


# ------------------------------------------------------------------- commands
def cmd_summary(df, args):
    n = df.attrs["nights"]
    rule(f"{df.attrs['hotel']} — {len(df)} plans, {n} nights")
    print(f"{'unique rate names':<28}{df['name'].nunique():>8}")
    print(f"{'unique rateCodes':<28}{df['rateCode'].nunique():>8}")
    print(f"{'unique prices':<28}{df['price'].nunique():>8}")
    print(f"{'room types (tier x bed)':<28}{df['roomType'].nunique():>8}")
    print(f"{'room type x option':<28}{df.groupby(['roomType', 'option']).ngroups:>8}")

    rule("price distribution (guest total for the stay)")
    print(df[["price", "feeAtProperty", "guestTotal", "perNight", "ssp", "spread"]].describe().round(2).to_string())

    rule("composition")
    for col in ["option", "rateType", "board", "sspSource"]:
        counts = df[col].value_counts()
        print(f"{col:<12} " + "   ".join(f"{k}={v}" for k, v in counts.head(6).items()))
    print(f"{'breakfast':<12} yes={int(df['breakfast'].sum())}   no={int((~df['breakfast']).sum())}")
    print(f"{'riverView':<12} yes={int(df['riverView'].sum())}   no={int((~df['riverView']).sum())}")
    print(f"{'accessible':<12} yes={int(df['accessible'].sum())}   no={int((~df['accessible']).sum())}")

    rule("cheapest by NET vs cheapest by GUEST TOTAL")
    a, b = df.loc[df["price"].idxmin()], df.loc[df["guestTotal"].idxmin()]
    for label, r in (("by net  ", a), ("by total", b)):
        print(f"{label}  ${r['price']:>8.2f} + ${r['feeAtProperty']:>7.2f} fee = ${r['guestTotal']:>8.2f}   {r['roomType']:<22} {r['option']}")
    if a["guestTotal"] != b["guestTotal"]:
        print(f"\nSorting on net costs the guest ${a['guestTotal'] - b['guestTotal']:.2f}. LiteAPI sorts on net.")


def cmd_rooms(df, args):
    rule("room type x option — cheapest guest total in each cell")
    grid = df.pivot_table(index="roomType", columns="option", values="guestTotal", aggfunc="min")
    grid["cheapest"] = grid.min(axis=1)
    grid["plans"] = df.groupby("roomType").size()
    if "Free cancellation" in grid and "Non-refundable" in grid:
        grid["flex costs"] = (grid["Free cancellation"] - grid["Non-refundable"]).round(2)
    print(grid.sort_values("cheapest").round(2).to_string())
    print(f"\n{len(df)} plans -> {len(grid)} room types. Edit TIER/BED at the top to regroup.")


def cmd_room(df, args):
    rule(f"plans matching room ~ '{args.name}'")
    sub = df[df["roomType"].str.contains(args.name, case=False, na=False)]
    if sub.empty:
        print("no match. available:")
        print("  " + "\n  ".join(sorted(df["roomType"].unique())))
        return
    best = (
        sub.groupby(["roomType", "option", "breakfast"])
        .apply(lambda g: g.loc[g["guestTotal"].idxmin()], include_groups=False)
        .reset_index()
    )
    cols = ["roomType", "option", "breakfast", "price", "feeAtProperty", "guestTotal", "spread", "feeKinds", "name"]
    print(best[cols].sort_values("guestTotal").to_string(index=False))
    rule("spread of guest totals within each cell (how much the duplicates differ)")
    print(
        sub.groupby(["roomType", "option"])["guestTotal"]
        .agg(["size", "min", "median", "max"])
        .round(2)
        .to_string()
    )


def cmd_outliers(df, args):
    rule("plans priced AT OR ABOVE their own public rate — unsellable")
    bad = df[df["price"] >= df["ssp"]]
    print(f"{len(bad)} of {len(df)} plans ({len(bad) / len(df) * 100:.0f}%)")
    if len(bad):
        print(bad.groupby("roomType")["guestTotal"].agg(["size", "min", "max"]).round(2).to_string())

    rule("the expensive tail")
    q = df["guestTotal"].quantile([0.5, 0.9, 0.99]).round(2)
    print(f"median ${q[0.5]}   p90 ${q[0.9]}   p99 ${q[0.99]}   max ${df['guestTotal'].max():.2f}")
    top = df.nlargest(12, "guestTotal")[["roomType", "option", "price", "feeAtProperty", "guestTotal", "ssp", "spread", "name"]]
    print(top.to_string(index=False))
    print("\nRerun with --sane to drop everything at or above SSP, or --max-total N.")


def cmd_fees(df, args):
    rule("fee structures collected at the property (corrected for per-night)")
    out = (
        df.groupby("feeKinds")
        .agg(plans=("price", "size"), feeMin=("feeAtProperty", "min"), feeMax=("feeAtProperty", "max"),
             cheapestTotal=("guestTotal", "min"))
        .sort_values("cheapestTotal")
    )
    print(out.round(2).to_string())

    rule("fee variation WITHIN an identical room + option")
    var = (
        df.groupby(["roomType", "option"])
        .agg(plans=("price", "size"), feeMin=("feeAtProperty", "min"), feeMax=("feeAtProperty", "max"),
             totalMin=("guestTotal", "min"), totalMax=("guestTotal", "max"))
        .assign(feeRange=lambda d: (d["feeMax"] - d["feeMin"]).round(2))
        .sort_values("feeRange", ascending=False)
    )
    print(var.head(15).round(2).to_string())


def cmd_options(df, args):
    rule("what each upsell costs, per room type")
    base = df[(df["option"] == "Non-refundable") & (~df["breakfast"])].groupby("roomType")["guestTotal"].min()
    rows = []
    for (opt, bf), grp in df.groupby(["option", "breakfast"]):
        cheapest = grp.groupby("roomType")["guestTotal"].min()
        delta = (cheapest - base).dropna()
        if len(delta):
            rows.append({
                "option": opt + (" + breakfast" if bf else ""),
                "rooms": len(delta),
                "min": round(delta.min(), 2),
                "median": round(delta.median(), 2),
                "max": round(delta.max(), 2),
            })
    print(pd.DataFrame(rows).to_string(index=False))
    print("\nBaseline is the cheapest non-refundable, no-breakfast plan for that room.")
    print("Negative values mean the data is inconsistent for that room — worth a look.")


def cmd_export(df, args):
    grid = (
        df.groupby(["roomType", "option", "breakfast"])
        .apply(lambda g: g.loc[g["guestTotal"].idxmin()], include_groups=False)
        .reset_index()
    )
    cols = ["roomType", "option", "breakfast", "price", "feeAtProperty", "guestTotal", "perNight",
            "ssp", "spread", "feeKinds", "riverView", "accessible", "rateType", "cancelBy", "name"]
    a = HERE / f"{df.attrs['hotel']}-grid.csv"
    b = HERE / f"{df.attrs['hotel']}-plans.csv"
    grid[cols].sort_values("guestTotal").to_csv(a, index=False)
    df.drop(columns=["feesOut"]).to_csv(b, index=False)
    print(f"{a.name:<28} {len(grid):>6} rows — bookable grid")
    print(f"{b.name:<28} {len(df):>6} rows — every plan")


COMMANDS = {
    "summary": cmd_summary, "rooms": cmd_rooms, "room": cmd_room,
    "outliers": cmd_outliers, "fees": cmd_fees, "options": cmd_options, "export": cmd_export,
}


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    f = sub.add_parser("fetch", help="pull fresh data (only command that hits the network)")
    f.add_argument("--hotel", default="lp1b919")
    f.add_argument("--checkin", default="2026-10-13")
    f.add_argument("--nights", type=int, default=2)
    f.add_argument("--adults", type=int, default=2)
    f.add_argument("--cap", type=int, default=10000, help="maxRatesPerHotel; keep high, see docstring")

    for name in COMMANDS:
        s = sub.add_parser(name)
        if name == "room":
            s.add_argument("name", help="substring of the room type")
        s.add_argument("--sane", action="store_true", help="drop plans priced at or above their SSP")
        s.add_argument("--max-total", type=float, default=None)
        s.add_argument("--room", default=None, help="substring filter on room type")
        s.add_argument("--refundable", action="store_true")
        s.add_argument("--non-refundable", action="store_true")
        s.add_argument("--breakfast", action="store_true")
        s.add_argument("--no-breakfast", action="store_true")

    args = p.parse_args()
    if args.cmd == "fetch":
        return fetch(args.hotel, args.checkin, args.nights, args.adults, args.cap)
    COMMANDS[args.cmd](load(args), args)


if __name__ == "__main__":
    sys.exit(main())
