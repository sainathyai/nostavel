"""Analysis of a single hotel's rate plans from LiteAPI.

Reads the two raw JSON pulls (margin 0 and margin 20, maxRatesPerHotel=1000)
and answers the structural questions: how many DISTINCT rooms/rates are really
there, what makes 1000 rows differ from each other, and whether the derived
columns in the CSV are trustworthy.

Run:  python analysis/analyze.py
"""

import json
from pathlib import Path

import pandas as pd

RAW = Path(__file__).parent / "raw"
HOTEL = "lp1b919"


def load(margin: int) -> pd.DataFrame:
    """Flatten one raw response into a row per rate plan."""
    # Supplier remarks carry non-cp1252 bytes; Windows' default codec chokes.
    data = json.loads((RAW / f"{HOTEL}-cap1000-margin{margin}.json").read_text(encoding="utf-8"))
    rows = []
    for rt in data:
        rate = (rt.get("rates") or [{}])[0]
        retail = rate.get("retailRate") or {}
        taxes = retail.get("taxesAndFees") or []
        cancel = rate.get("cancellationPolicies") or {}
        rows.append(
            {
                "roomTypeId": rt.get("roomTypeId", ""),
                "offerId": rt.get("offerId", ""),
                "rateId": rate.get("rateId", ""),
                "rateCode": rate.get("rateCode", ""),
                "name": " ".join((rate.get("name") or "").split()),
                "board": rate.get("boardType", ""),
                "refundable": (cancel.get("refundableTag") or ""),
                "rateType": rt.get("rateType", ""),
                "priceType": rt.get("priceType", ""),
                "maxOccupancy": rate.get("maxOccupancy"),
                "adultCount": rate.get("adultCount"),
                "supplier": rt.get("supplier", ""),
                "supplierId": rt.get("supplierId"),
                "price": (rt.get("offerRetailRate") or {}).get("amount"),
                "ssp": (rt.get("suggestedSellingPrice") or {}).get("amount"),
                "sspSource": (rt.get("suggestedSellingPrice") or {}).get("source", ""),
                "commission": (rate.get("commission") or [{}])[0].get("amount"),
                # Split the fee rows: what's inside the price vs collected on site.
                "taxIncluded": sum(t["amount"] for t in taxes if t.get("included") is True),
                "feeAtProperty": sum(t["amount"] for t in taxes if t.get("included") is False),
                "feeLabels": "; ".join(
                    t.get("description", "") for t in taxes if t.get("included") is False
                ),
                "nFeeRows": len(taxes),
                "cancelTiers": len(cancel.get("cancelPolicyInfos") or []),
            }
        )
    return pd.DataFrame(rows)


def rule(title: str) -> None:
    print(f"\n{'=' * 78}\n{title}\n{'=' * 78}")


a = load(0)
b = load(20)

rule("1. HOW MANY PLANS, AND HOW MANY ARE ACTUALLY DISTINCT?")
print(f"rows returned                     {len(a)}")
for col in ["roomTypeId", "offerId", "rateId", "rateCode", "name", "price"]:
    print(f"unique {col:<26} {a[col].nunique()}")
# The combination a human would call "a different thing to book".
combo = ["name", "board", "refundable", "price", "feeAtProperty"]
print(f"unique {'|'.join(combo):<26} {a.drop_duplicates(combo).shape[0]}")
print(f"\nrows per distinct (name, price, refundable): ")
dup = a.groupby(["name", "price", "refundable"]).size().sort_values(ascending=False)
print(f"  max {dup.max()}, median {int(dup.median())}, groups {len(dup)}")

rule("2. rateType AND supplier BREAKDOWN")
print(a["rateType"].value_counts().to_string())
print()
print(a.groupby(["rateType", "refundable"]).size().to_string())
print()
print("supplier:", a["supplier"].value_counts().to_dict())
print("priceType:", a["priceType"].value_counts().to_dict())

rule("3. maxOccupancy — is it room capacity or our requested occupancy?")
print(a["maxOccupancy"].value_counts(dropna=False).to_string())
print(f"\nadultCount values: {a['adultCount'].value_counts(dropna=False).to_dict()}")
twoQueens = a[a["name"].str.contains("2 QUEEN|2 QN|Two Queen", case=False, na=False)]
print(f"\nrows naming two queen beds: {len(twoQueens)}")
print(f"  their maxOccupancy values: {sorted(twoQueens['maxOccupancy'].dropna().unique().tolist())}")
print("\nWe requested occupancies=[{adults: 2}]. If every maxOccupancy is 2")
print("regardless of bed configuration, the field is echoing the REQUEST, not")
print("the room's capacity — it would need a second call at adults=4 to confirm.")

rule("4. JOINING THE TWO CALLS")
for key in ["roomTypeId", "offerId", "rateId", "rateCode"]:
    shared = len(set(a[key]) & set(b[key]))
    print(f"{key:<12} shared between calls: {shared:>5} / {len(a)}    unique in call 1: {a[key].nunique()}")
combo_key = a["name"] + "|" + a["board"] + "|" + a["refundable"] + "|" + a["feeAtProperty"].round(2).astype(str)
combo_key_b = b["name"] + "|" + b["board"] + "|" + b["refundable"] + "|" + b["feeAtProperty"].round(2).astype(str)
print(f"{'name|board|ref|fee':<12} shared: {len(set(combo_key) & set(combo_key_b)):>5} / {len(a)}    unique in call 1: {combo_key.nunique()}")

rule("5. THE 229 UNMATCHED AND THE 16 ODD SSP RATIOS")
merged = a.merge(b, on="roomTypeId", how="left", suffixes=("_0", "_20"))
merged["price_ratio"] = merged["price_20"] / merged["price_0"]
merged["ssp_ratio"] = merged["ssp_20"] / merged["ssp_0"]
print(f"rows after left join on roomTypeId: {len(merged)} (join is NOT 1:1 if > {len(a)})")
print(f"unmatched (no roomTypeId in call 2): {merged['price_20'].isna().sum()}")
print("\nssp_ratio value counts:")
print(merged["ssp_ratio"].round(4).value_counts(dropna=False).to_string())
odd = merged[(merged["ssp_ratio"].round(4) != 1.0) & merged["ssp_ratio"].notna()]
if len(odd):
    print(f"\nthe {len(odd)} odd rows — do they look like mis-joins?")
    print(odd[["name_0", "price_0", "price_20", "ssp_0", "ssp_20", "rateType_0", "rateType_20"]].head(8).to_string(index=False))
    print("\nIf name_0 != name_20 on these rows, roomTypeId collided and the pairing")
    print("is wrong — not evidence that LiteAPI moved the SSP.")
    mismatch = (odd["name_0"] != odd["name_20"]).sum()
    print(f"rows where the NAME differs across the join: {mismatch} of {len(odd)}")

rule("6. THE guestTotal COLUMN — IS IT RIGHT?")
print("guestTotal_m20 was computed as price_m20 + feeAtProperty. Two problems:")
print()
fee_labels = a[a["feeAtProperty"] > 0]["feeLabels"].value_counts()
print(fee_labels.to_string())
print()
per_night = a["feeLabels"].str.contains("Per Night|per night", case=False, na=False)
print(f"rows whose fee label says PER NIGHT: {per_night.sum()}")
print("  -> for a 2-night stay those amounts must be doubled; the CSV did not.")
print(f"rows with NO fee at property at all : {(a['feeAtProperty'] == 0).sum()}")
print(f"rows left blank because unmatched   : {merged['price_20'].isna().sum()}")
print()
sample = a[per_night][["name", "price", "feeAtProperty", "feeLabels"]].head(3)
if len(sample):
    print("example per-night fee rows:")
    print(sample.to_string(index=False))

rule("7. PRICE AND SPREAD")
print(f"net range        ${a['price'].min():.2f} .. ${a['price'].max():.2f}")
print(f"distinct nets    {a['price'].nunique()}")
a["spread"] = a["ssp"] / a["price"]
print(f"SSP/net spread   min {a['spread'].min():.3f}  median {a['spread'].median():.3f}  max {a['spread'].max():.3f}")
print(f"synthetic (1.15) {int((a['spread'].sub(1.15).abs() < 0.005).sum())}")
print()
print("cheapest per refundability:")
print(a.groupby("refundable")["price"].agg(["min", "median", "max", "count"]).round(2).to_string())
print()
print("cheapest plan per fee structure (this is what a guest actually pays):")
tot = a.assign(guestTotal=a["price"] + a["feeAtProperty"])
print(
    tot.groupby("feeLabels")
    .agg(n=("price", "size"), cheapest_net=("price", "min"), fee=("feeAtProperty", "max"), cheapest_total=("guestTotal", "min"))
    .sort_values("cheapest_total")
    .round(2)
    .to_string()
)
