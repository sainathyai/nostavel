#!/usr/bin/env python
"""Is suggestedSellingPrice a real public rate, or net x a per-hotel constant?

For each hotel we pull every rate plan and look at the distribution of
ssp / net. Two outcomes tell very different stories:

  * tight within a hotel, different across hotels
        -> SSP is a FORMULA with a per-hotel (or per-search) multiplier.
           It carries no per-rate information and cannot support a claim like
           "this room is 30% below the public rate" for any individual room.

  * varies within a hotel
        -> SSP is genuinely per-rate market data and is worth comparing against.

    python analysis/spread.py --city "New Orleans" --hotels 10
    python analysis/spread.py --ids lp1b919,lp254b4 --checkin 2026-12-20
"""

from __future__ import annotations

import argparse
import json
import sys
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


def post(body: dict) -> dict:
    req = urllib.request.Request(
        f"{BASE}/hotels/rates",
        data=json.dumps(body).encode(),
        headers={"X-API-Key": KEY, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read().decode())


def rates(body_extra: dict, checkin: str, nights: int, cap: int) -> list[dict]:
    checkout = (pd.Timestamp(checkin) + pd.Timedelta(days=nights)).strftime("%Y-%m-%d")
    return post(
        {
            "occupancies": [{"adults": 2}],
            "currency": "USD",
            "guestNationality": "US",
            "checkin": checkin,
            "checkout": checkout,
            "maxRatesPerHotel": cap,
            "margin": 0,  # SSP is only meaningful here
            "timeout": 12,
            **body_extra,
        }
    ).get("data") or []


def plan_rows(entry: dict) -> list[dict]:
    out = []
    for rt in entry.get("roomTypes") or []:
        net = (rt.get("offerRetailRate") or {}).get("amount")
        ssp = (rt.get("suggestedSellingPrice") or {}).get("amount")
        if not net or not ssp:
            continue
        rate = (rt.get("rates") or [{}])[0]
        out.append(
            {
                "hotelId": entry.get("hotelId"),
                "net": net,
                "ssp": ssp,
                "spread": round(ssp / net, 4),
                "refundable": (rate.get("cancellationPolicies") or {}).get("refundableTag", ""),
                "rateType": rt.get("rateType", ""),
                "source": (rt.get("suggestedSellingPrice") or {}).get("source", ""),
            }
        )
    return out


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--city", default="New Orleans")
    p.add_argument("--country", default="US")
    p.add_argument("--ids", default=None, help="comma-separated hotelIds, overrides --city")
    p.add_argument("--hotels", type=int, default=10, help="how many hotels to profile")
    p.add_argument("--checkin", default="2026-10-13")
    p.add_argument("--nights", type=int, default=2)
    p.add_argument("--cap", type=int, default=1500, help="maxRatesPerHotel per hotel pull")
    args = p.parse_args()

    if args.ids:
        ids = [x.strip() for x in args.ids.split(",") if x.strip()]
    else:
        print(f"finding hotels in {args.city} ...")
        city = rates({"cityName": args.city, "countryCode": args.country, "limit": 200}, args.checkin, args.nights, 1)
        ids = [e["hotelId"] for e in city][: args.hotels]
        print(f"  {len(city)} hotels returned, profiling {len(ids)}\n")

    frames = []
    for i, hid in enumerate(ids, 1):
        try:
            entries = rates({"hotelIds": [hid]}, args.checkin, args.nights, args.cap)
        except Exception as exc:  # noqa: BLE001 - one bad hotel shouldn't stop the run
            print(f"  {i:>2}. {hid:<12} FAILED {exc}")
            continue
        rows = [r for e in entries for r in plan_rows(e)]
        if not rows:
            print(f"  {i:>2}. {hid:<12} no rates")
            continue
        d = pd.DataFrame(rows)
        frames.append(d)
        s = d["spread"]
        flag = "CONSTANT" if s.std() < 0.005 else ("tight" if s.std() < 0.05 else "VARIES")
        print(
            f"  {i:>2}. {hid:<12} {len(d):>5} plans   "
            f"spread min {s.min():.3f}  median {s.median():.3f}  max {s.max():.3f}  "
            f"std {s.std():.4f}   {flag}"
        )

    if not frames:
        raise SystemExit("nothing collected")
    df = pd.concat(frames, ignore_index=True)

    print(f"\n{'=' * 96}\nPER-HOTEL SUMMARY\n{'=' * 96}")
    per = (
        df.groupby("hotelId")["spread"]
        .agg(plans="size", min="min", median="median", max="max", std="std", distinct="nunique")
        .sort_values("median")
    )
    print(per.round(4).to_string())

    print(f"\n{'=' * 96}\nVERDICT\n{'=' * 96}")
    constant = per[per["std"] < 0.005]
    varies = per[per["std"] >= 0.05]
    print(f"hotels profiled                 {len(per)}")
    print(f"spread effectively CONSTANT     {len(constant)}  (std < 0.005)")
    print(f"spread genuinely VARIES         {len(varies)}  (std >= 0.05)")
    print(f"in between                      {len(per) - len(constant) - len(varies)}")
    print(f"\ndistinct median spreads across hotels: {sorted(per['median'].unique())}")
    if len(constant):
        print("\nIf a hotel's spread is constant, its SSP is net x that constant and")
        print("carries no information about any individual room's market price.")

    # Does the multiplier cluster on suspicious round numbers?
    print(f"\nmost common spread values overall (top 12):")
    print(df["spread"].value_counts().head(12).to_string())

    df.to_csv(HERE / "spread-by-hotel.csv", index=False)
    print(f"\nwrote analysis/spread-by-hotel.csv ({len(df)} plans)")


if __name__ == "__main__":
    main()
