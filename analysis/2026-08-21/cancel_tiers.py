#!/usr/bin/env python
"""What is actually inside cancellationPolicies, and does our margin reach it?

Two things we display depend on the answer.

1. TIERS. `cancelPolicyInfos` is a LADDER, not a single deadline. Each entry is
   "from this instant, cancelling costs this much". Free cancellation is the
   window BEFORE the first entry's cancelTime. The app currently reads
   cancelPolicyInfos[0].cancelTime as "free until" and throws the rest away,
   which hides genuinely guest-favourable information: after the first deadline
   a stay is often still only PART-penalised, not lost.

2. MARGIN. The penalty amounts have to be quoted on what the GUEST PAID, not on
   supplier net. If LiteAPI does not mark these up the way it marks up
   offerRetailRate, then displaying them verbatim understates the penalty and we
   would be publishing a number we cannot honour.

    python analysis/2026-08-21/cancel_tiers.py
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from datetime import date, timedelta
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).resolve().parent
BASE = "https://api.liteapi.travel/v3.0"
KEY = [
    l.partition("=")[2].strip().strip("\"'")
    for l in (HERE.parent.parent / ".env.local").read_text(encoding="utf-8").splitlines()
    if l.startswith("LITEAPI_KEY")
][0]


def rates(hotel: str, ci: date, margin: int):
    body = {
        "hotelIds": [hotel],
        "occupancies": [{"adults": 2}],
        "currency": "USD",
        "guestNationality": "US",
        "checkin": ci.isoformat(),
        "checkout": (ci + timedelta(days=2)).isoformat(),
        "maxRatesPerHotel": 2000,
        "roomMapping": True,
        "timeout": 5,
        "margin": margin,
    }
    req = urllib.request.Request(
        BASE + "/hotels/rates",
        data=json.dumps(body).encode(),
        headers={"X-API-Key": KEY, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read().decode()).get("data") or []
    except urllib.error.HTTPError as e:
        print("  HTTP", e.code, e.read().decode()[:200])
        return []


def plans(data, margin: int):
    """key -> (charged total, net total, tier list). Key survives a margin change."""
    out = {}
    for entry in data or []:
        for rt in entry.get("roomTypes") or []:
            if rt.get("rateType") == "package":
                continue
            amt = (rt.get("offerRetailRate") or {}).get("amount")
            if amt is None:
                continue
            ra = (rt.get("rates") or [{}])[0]
            cp = ra.get("cancellationPolicies") or {}
            key = (
                ra.get("mappedRoomId") or rt.get("roomTypeId"),
                (ra.get("boardName") or "").strip().lower(),
                cp.get("refundableTag"),
            )
            tiers = [
                (i.get("cancelTime"), i.get("amount"), i.get("type"), i.get("timezone"))
                for i in (cp.get("cancelPolicyInfos") or [])
            ]
            out.setdefault(key, (amt, amt / (1 + margin / 100), tiers))
    return out


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--hotels", default="lp85c07,lp1b919,lp225d01,lp40992")
    p.add_argument("--margin", type=int, default=12)
    args = p.parse_args()

    print("=" * 78)
    print("1. SHAPE OF THE LADDER (margin 0)")
    print("=" * 78)
    zones, shapes = set(), {}
    for h in [x.strip() for x in args.hotels.split(",") if x.strip()]:
        ci = date.today() + timedelta(days=60)
        ps = plans(rates(h, ci, 0), 0)
        multi = [(k, v) for k, v in ps.items() if len(v[2]) > 1]
        one = [(k, v) for k, v in ps.items() if len(v[2]) == 1]
        none = [(k, v) for k, v in ps.items() if not v[2]]
        print(f"\n{h}  {len(ps)} plans: {len(none)} with no tiers, "
              f"{len(one)} one-tier, {len(multi)} multi-tier")
        for k, v in ps.items():
            for t in v[2]:
                zones.add(t[3])
        for label, sample in (("multi", multi), ("one", one)):
            if sample:
                k, (amt, net, tiers) = sample[0]
                print(f"  {label}-tier example  tag={k[2]}  total charged {amt:.2f}")
                for ct, a, ty, tz in tiers:
                    pct = f"{a / amt:.0%}" if amt else "?"
                    print(f"      from {ct} {tz}   penalty {a:>9.2f} ({pct} of total)  type={ty}")
        shapes[h] = (len(none), len(one), len(multi))

    print(f"\ntimezone values seen across every tier: {zones or '(none)'}")

    print()
    print("=" * 78)
    print(f"2. DOES OUR MARGIN REACH THE PENALTY AMOUNTS? (margin 0 vs {args.margin})")
    print("=" * 78)
    print("If a penalty is marked up like the rate, penalty2/penalty1 == 1 + margin/100.")
    print("If it is quoted on supplier net, the ratio stays 1.00 and displaying it")
    print("verbatim would understate what the guest actually loses.\n")
    for h in [x.strip() for x in args.hotels.split(",") if x.strip()]:
        ci = date.today() + timedelta(days=61)
        a = plans(rates(h, ci, 0), 0)
        b = plans(rates(h, ci, args.margin), args.margin)
        common = [k for k in a if k in b and a[k][2] and b[k][2]]
        rows = 0
        print(f"{h}  {len(common)} plans present in both with tiers")
        for k in common[:4]:
            amt0, _, t0 = a[k]
            amt1, _, t1 = b[k]
            if len(t0) != len(t1):
                print(f"  tier COUNT changed {len(t0)} -> {len(t1)}, skipping")
                continue
            rate_ratio = amt1 / amt0 if amt0 else 0
            for (ct0, p0, _, _), (ct1, p1, _, _) in zip(t0, t1):
                pen_ratio = p1 / p0 if p0 else 0
                same_time = "same" if ct0 == ct1 else f"MOVED {ct0} -> {ct1}"
                print(f"  rate x{rate_ratio:.4f}   penalty {p0:>8.2f} -> {p1:>8.2f} "
                      f"x{pen_ratio:.4f}   deadline {same_time}")
                rows += 1
        if not rows:
            print("  (no comparable plan survived to both calls)")
        print()


if __name__ == "__main__":
    main()
