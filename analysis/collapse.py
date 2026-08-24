"""Collapse one hotel's 6,600 rate plans into an OTA-style room list.

The model this assumes, which the data supports:

    ROOM TYPE   what you sleep in        tier + bed configuration
    ATTRIBUTES  facts about that room    view, accessibility, size
    OPTIONS     what you choose to buy   refundable?  breakfast?
    RATE PLANS  supplier duplicates      many per option, differing in
                                         price AND in fees collected on site

A guest picks a ROOM TYPE, then an OPTION. Everything else is noise that
belongs in bullets or is chosen for them by taking the cheapest GUEST TOTAL —
not the cheapest net, which is a different plan entirely.

Run:  python analysis/collapse.py
"""

import json
import re
from pathlib import Path

import pandas as pd

RAW = Path(__file__).parent / "raw"
OUT = Path(__file__).parent
NIGHTS = 2

df = pd.DataFrame(json.loads((RAW / "lp1b919-full.json").read_text(encoding="utf-8")))


def rule(t):
    print(f"\n{'=' * 78}\n{t}\n{'=' * 78}")


# ------------------------------------------------------------ fees, per stay
def fee_total(fees):
    """Property-collected fees for the WHOLE stay.

    The label carries the basis. 'Resort Fee Per Room Per Night' at $70.50 is
    $141 across two nights; summing it once understates the guest total by the
    single largest amount in the dataset.
    """
    total = 0.0
    for f in fees:
        amt = f.get("a") or 0
        if re.search(r"per\s*(room\s*)?(per\s*)?night", f.get("d", ""), re.I):
            amt *= NIGHTS
        total += amt
    return round(total, 2)


df["feeAtProperty"] = df["feesOut"].apply(fee_total)
df["feeKinds"] = df["feesOut"].apply(lambda fs: "; ".join(sorted(f["d"] for f in fs)) or "(none)")
df["guestTotal"] = (df["price"] + df["feeAtProperty"]).round(2)

# ------------------------------------------------- room type: tier + bed only
# Order matters: the most specific product word wins.
TIER = [
    (r"presidential", "Presidential Suite"),
    (r"executive\s+suite", "Executive Suite"),
    (r"junior\s+(king\s+)?suite", "Junior Suite"),
    (r"studio\s+suite|studio", "Studio Suite"),
    (r"\bparlor\b|murphy", "Parlor"),
    (r"\bsuite\b|bedroom suite", "Suite"),
    (r"riverside|riverfront", "Riverside"),
    (r"premium", "Premium"),
    (r"deluxe", "Deluxe"),
    (r"standard|^room\b", "Standard"),
]
BED = [
    (r"\b2\s*(queen|qn)\b|two queen|2 queen beds", "2 Queens"),
    (r"\b2\s*doubles?\b|double room", "2 Doubles"),
    (r"\b1\s*king\b|one king|king bed|\bking\b", "1 King"),
    (r"\b1\s*(queen|qn)\b|\bqueen\b", "1 Queen"),
    (r"\btwin\b", "Twin"),
    (r"sofa", "Sofa bed"),
]


def match(pats, s, default):
    for pat, label in pats:
        if re.search(pat, s, re.I):
            return label
    return default


df["tier"] = df["name"].apply(lambda n: match(TIER, n, "Standard"))
df["bed"] = df["name"].apply(lambda n: match(BED, n, "Unspecified"))
df["roomType"] = df["tier"] + " · " + df["bed"]

# Attributes — described, never used to split a room type.
df["riverView"] = df["name"].str.contains(r"river\s*view|riverfront|riverside", case=False, na=False)
df["accessible"] = df["name"].str.contains(
    r"accessib|mobility|hearing|roll-?in|visual|disabilit", case=False, na=False
)
df["breakfast"] = df["board"].str.upper().ne("RO") | df["boardName"].str.contains(
    "breakfast", case=False, na=False
)
df["option"] = df["refundable"].map({"RFN": "Free cancellation", "NRFN": "Non-refundable"}).fillna("?")

rule("1. THE COLLAPSE")
print(f"rate plans returned                {len(df):>6}")
print(f"unique rate names                  {df['name'].nunique():>6}")
print(f"unique rateCodes                   {df['rateCode'].nunique():>6}")
print(f"unique prices                      {df['price'].nunique():>6}")
print(f"-> ROOM TYPES (tier x bed)         {df['roomType'].nunique():>6}")
print(f"-> room type x option              {df.groupby(['roomType', 'option']).ngroups:>6}")
print(f"-> room type x option x breakfast  {df.groupby(['roomType', 'option', 'breakfast']).ngroups:>6}")
print("\nroom types found:")
for rt, n in df["roomType"].value_counts().items():
    print(f"   {rt:<28} {n:>5} plans")

rule("2. THE ROOM LIST — cheapest GUEST TOTAL per room type x option")
grid = (
    df.groupby(["roomType", "option"])
    .apply(lambda g: g.loc[g["guestTotal"].idxmin()], include_groups=False)
    .reset_index()[
        ["roomType", "option", "price", "feeAtProperty", "guestTotal", "ssp", "breakfast", "riverView", "accessible"]
    ]
)
grid["spread"] = (grid["ssp"] / grid["price"]).round(3)
piv = grid.pivot_table(index="roomType", columns="option", values="guestTotal", aggfunc="min")
piv["cheapest"] = piv.min(axis=1)
piv["free cancel costs"] = (piv.get("Free cancellation") - piv.get("Non-refundable")).round(2)
print(piv.sort_values("cheapest").round(2).to_string())

rule("3. CHEAPEST NET vs CHEAPEST TOTAL — do they pick the same plan?")
by_net = df.loc[df["price"].idxmin()]
by_total = df.loc[df["guestTotal"].idxmin()]
print(f"cheapest NET     ${by_net['price']:>8.2f} + ${by_net['feeAtProperty']:>7.2f} fee = ${by_net['guestTotal']:>8.2f}   {by_net['roomType']}")
print(f"cheapest TOTAL   ${by_total['price']:>8.2f} + ${by_total['feeAtProperty']:>7.2f} fee = ${by_total['guestTotal']:>8.2f}   {by_total['roomType']}")
print(f"\ndifference to the guest: ${by_net['guestTotal'] - by_total['guestTotal']:.2f}")
print("LiteAPI sorts by net, so maxRatesPerHotel=1 returns the first line, not the second.")

rule("4. FEE SPREAD WITHIN AN IDENTICAL ROOM + OPTION")
var = (
    df.groupby(["roomType", "option"])
    .agg(plans=("price", "size"), feeMin=("feeAtProperty", "min"), feeMax=("feeAtProperty", "max"),
         totalMin=("guestTotal", "min"), totalMax=("guestTotal", "max"))
    .assign(feeRange=lambda d: (d["feeMax"] - d["feeMin"]).round(2))
    .sort_values("feeRange", ascending=False)
)
print(var.head(10).round(2).to_string())
print(f"\nSame room, same cancellation terms, fee differing by up to ${var['feeRange'].max():.2f}.")

rule("5. WRITTEN OUT")
grid_full = (
    df.groupby(["roomType", "option", "breakfast"])
    .apply(lambda g: g.loc[g["guestTotal"].idxmin()], include_groups=False)
    .reset_index()
)
cols = ["roomType", "option", "breakfast", "price", "feeAtProperty", "guestTotal", "feeKinds",
        "ssp", "riverView", "accessible", "rateType", "cancelBy", "name"]
grid_full[cols].sort_values(["guestTotal"]).to_csv(OUT / "lp1b919-rooms.csv", index=False)
df.drop(columns=["feesIn", "feesOut"]).to_csv(OUT / "lp1b919-all-plans.csv", index=False)
print(f"analysis/lp1b919-rooms.csv      {len(grid_full)} rows — the bookable grid")
print(f"analysis/lp1b919-all-plans.csv  {len(df)} rows — every plan, fees corrected")
