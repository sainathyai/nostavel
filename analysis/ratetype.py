#!/usr/bin/env python
"""How much does the standard/package split actually buy us?

Two questions, kept separate because they have different answers:

  1. VOLUME  - if we drop (or keep) package rates, how many plans remain?
  2. FENCE   - is `package` the right flag for "only show this to a logged-in
               user"? LiteAPI's own docs say no: package is a *subset* of
               closed-user-group rates, so fencing on it alone both leaks
               below-SSP standard rates and needlessly hides package rates
               that sit above SSP. We measure that leakage here.

    python analysis/ratetype.py --ids lp1b919 --cap 6000
    python analysis/ratetype.py --city "New Orleans" --hotels 12
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
    with urllib.request.urlopen(req, timeout=240) as r:
        return json.loads(r.read().decode())


def pull(extra: dict, checkin: str, nights: int, cap: int) -> list[dict]:
    checkout = (pd.Timestamp(checkin) + pd.Timedelta(days=nights)).strftime("%Y-%m-%d")
    return post(
        {
            "occupancies": [{"adults": 2}],
            "currency": "USD",
            "guestNationality": "US",
            "checkin": checkin,
            "checkout": checkout,
            "maxRatesPerHotel": cap,
            # SSP is only trustworthy at margin 0, and the whole fencing
            # question is "is our price below SSP", so margin must be 0 here.
            "margin": 0,
            "timeout": 12,
            **extra,
        }
    ).get("data") or []


def rows(entries: list[dict]) -> pd.DataFrame:
    out = []
    for e in entries:
        for rt in e.get("roomTypes") or []:
            net = (rt.get("offerRetailRate") or {}).get("amount")
            ssp = (rt.get("suggestedSellingPrice") or {}).get("amount")
            rate = (rt.get("rates") or [{}])[0]
            cancel = rate.get("cancellationPolicies") or {}
            out.append(
                {
                    "hotelId": e.get("hotelId"),
                    "rateType": rt.get("rateType") or "unknown",
                    "net": net,
                    "ssp": ssp,
                    "refundable": cancel.get("refundableTag") == "RFN",
                    "board": rate.get("boardName", ""),
                    "room": rate.get("name", ""),
                }
            )
    d = pd.DataFrame(out)
    if d.empty:
        return d
    d["spread"] = (d["ssp"] / d["net"]).round(4)
    # A no-data placeholder, not real market pricing: exactly 1.15.
    d["synthetic_ssp"] = (d["spread"] - 1.15).abs() < 0.005
    return d


def section(title: str) -> None:
    print(f"\n{'=' * 78}\n{title}\n{'=' * 78}")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--ids", default=None, help="comma-separated hotelIds")
    p.add_argument("--city", default="New Orleans")
    p.add_argument("--country", default="US")
    p.add_argument("--hotels", type=int, default=12)
    p.add_argument("--checkin", default="2026-10-13")
    p.add_argument("--nights", type=int, default=2)
    p.add_argument("--cap", type=int, default=1000)
    p.add_argument("--margin", type=float, default=15.0,
                   help="margin we would charge, used to test the SSP fence")
    args = p.parse_args()

    if args.ids:
        ids = [x.strip() for x in args.ids.split(",") if x.strip()]
    else:
        city = pull({"cityName": args.city, "countryCode": args.country, "limit": 200},
                    args.checkin, args.nights, 1)
        ids = [e["hotelId"] for e in city][: args.hotels]
        print(f"{len(city)} hotels in {args.city}; profiling {len(ids)}")

    frames = []
    for i, hid in enumerate(ids, 1):
        try:
            d = rows(pull({"hotelIds": [hid]}, args.checkin, args.nights, args.cap))
        except Exception as exc:  # noqa: BLE001
            print(f"  {i:>2}. {hid:<12} FAILED {exc}")
            continue
        if d.empty:
            print(f"  {i:>2}. {hid:<12} no rates")
            continue
        frames.append(d)
        n = len(d)
        pk = int((d["rateType"] == "package").sum())
        print(f"  {i:>2}. {hid:<12} {n:>5} plans   package {pk:>5} ({pk / n:5.1%})   "
              f"standard {n - pk:>5} ({1 - pk / n:5.1%})")

    if not frames:
        raise SystemExit("nothing collected")
    df = pd.concat(frames, ignore_index=True)

    section("1. VOLUME - what each filter leaves behind")
    total = len(df)
    pkg = df[df["rateType"] == "package"]
    std = df[df["rateType"] == "standard"]
    print(f"all plans                      {total:>6}")
    print(f"keep package only              {len(pkg):>6}   ({len(pkg) / total:.1%} of all, "
          f"a {1 - len(pkg) / total:.0%} cut)")
    print(f"drop package (public-safe-ish)  {len(std):>6}   ({len(std) / total:.1%} of all, "
          f"a {1 - len(std) / total:.0%} cut)")
    print(f"\nrefundable share  package {pkg['refundable'].mean():.1%}   "
          f"standard {std['refundable'].mean():.1%}")
    print(f"distinct rooms    package {pkg['room'].nunique():>4}   "
          f"standard {std['room'].nunique():>4}")

    section(f"2. FENCE - would our price at margin {args.margin:g}% sit below SSP?")
    # The rule that actually matters: public display must be at or above SSP.
    real = df[~df["synthetic_ssp"] & df["ssp"].notna()].copy()
    real["our_price"] = real["net"] * (1 + args.margin / 100)
    real["below_ssp"] = real["our_price"] < real["ssp"]
    print(f"plans with a real (non-placeholder) SSP   {len(real)} of {total} "
          f"({len(real) / total:.1%})")
    if len(real):
        x = pd.crosstab(real["rateType"], real["below_ssp"])
        x.columns = [("at/above SSP - public OK" if not c else "below SSP - login only")
                     for c in x.columns]
        print()
        print(x.to_string())
        below = real[real["below_ssp"]]
        leak = below[below["rateType"] == "standard"]
        hidden = real[(real["rateType"] == "package") & ~real["below_ssp"]]
        print(f"\nfencing on `package` alone:")
        print(f"  LEAKS   {len(leak):>5} standard plans that are below SSP and would be "
              f"shown publicly ({len(leak) / max(len(below), 1):.1%} of all below-SSP plans)")
        print(f"  HIDES   {len(hidden):>5} package plans that are at/above SSP and could "
              f"legally have been public")

    section("3. Like-for-like: does package actually undercut standard?")
    cmp_ = (df.groupby(["room", "board", "refundable", "rateType"])["net"].min()
              .unstack("rateType"))
    if {"package", "standard"} <= set(cmp_.columns):
        cmp_ = cmp_.dropna(subset=["package", "standard"])
        cmp_["pkg_vs_std_pct"] = (cmp_["package"] / cmp_["standard"] - 1) * 100
        c = cmp_["pkg_vs_std_pct"]
        print(f"comparable cells {len(cmp_)}   median {c.median():+.2f}%   "
              f"mean {c.mean():+.2f}%")
        print(f"package cheaper {(c < -0.01).sum()}   equal {(c.abs() <= 0.01).sum()}   "
              f"pricier {(c > 0.01).sum()}")
    else:
        print("not enough overlap to compare")

    df.to_csv(HERE / "ratetype-split.csv", index=False)
    print(f"\nwrote analysis/ratetype-split.csv ({len(df)} plans)")


if __name__ == "__main__":
    main()
