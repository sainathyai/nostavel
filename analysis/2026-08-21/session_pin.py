#!/usr/bin/env python
"""Does `sessionId` pin the SUPPLIER SET across the detail page's two calls?

The detail page cannot make one request. `margin` is per-request, and the margin
we may charge is only knowable from a margin-0 response (pricing.ts). So we call
twice: baseline at margin 0 to read true net and a real suggestedSellingPrice,
then priced at the margin that evidence permits, to get bookable offerIds.

The risk is not latency. It is that ONE hotelId is a live fan-out to many
wholesalers, so the second call may come back from a DIFFERENT set of suppliers
than the one the margin was computed from. When that happens the parity ceiling
we honoured was derived from inventory that is no longer on the page, and the
price we show a guest was justified by evidence that has vanished.

`sessionId` is documented as price consistency: same sessionId + same dates keeps
prices stable across a session. Whether it also pins WHICH SUPPLIERS ANSWER is
undocumented, and is the whole question here.

Three arms per hotel, because "the two calls disagree" has two possible causes
and they must be separated:

  CONTROL   margin 0 + sessionId S1, then margin 0 + sessionId S2.
            Same commercial params, two independent sessions. Whatever churn
            shows up here is INHERENT to calling twice and has nothing to do
            with margin. This is the floor any other arm is measured against.

  LOOSE     margin 0 (no sessionId), then margin M (no sessionId).
            Exactly what src/lib/liteapi.ts does today.

  PINNED    margin 0 + sessionId S, then margin M + the SAME sessionId S.
            The proposed fix.

If PINNED beats LOOSE and approaches 1.0, adopt sessionId. If all three sit
together, the churn is inherent to the fan-out and sessionId is not the answer.

Every call gets a UNIQUE check-in date. LiteAPI caches a response for identical
params (measured 2026-08-20: 2.77s cold then 0.35s twice, byte-identical), and
an earlier study measured that cache instead of the API. Note that arms differ
in sessionId, which is itself part of the cache key -- the unique dates are belt
and braces, and they also keep one arm from warming the next.

    python analysis/2026-08-21/session_pin.py
    python analysis/2026-08-21/session_pin.py --hotels lp85c07 --margin 12
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
import urllib.error
import urllib.request
import uuid
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

RATE_FETCH_CAP = 2000  # match the app exactly
TIMEOUT_S = 5


def rates(hotel: str, ci: date, margin: int, session: str | None):
    body = {
        "hotelIds": [hotel],
        "occupancies": [{"adults": 2}],
        "currency": "USD",
        "guestNationality": "US",
        "checkin": ci.isoformat(),
        "checkout": (ci + timedelta(days=2)).isoformat(),
        "maxRatesPerHotel": RATE_FETCH_CAP,
        "roomMapping": True,
        "timeout": TIMEOUT_S,
        "margin": margin,
    }
    if session:
        body["sessionId"] = session
    req = urllib.request.Request(
        BASE + "/hotels/rates",
        data=json.dumps(body).encode(),
        headers={"X-API-Key": KEY, "Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            d = json.loads(r.read().decode())
        return (d.get("data") or []), time.time() - t0, None
    except urllib.error.HTTPError as e:
        return [], time.time() - t0, f"HTTP {e.code}: {e.read().decode()[:200]}"


def offers(data, margin: int):
    """Every standard offer, keyed so it survives a margin change.

    offerId and rateId are regenerated per request (measured: 0/50 stable across
    a margin change), so they cannot pair anything. What DOES survive is the
    supplier, the mapped physical room, the board, the refund policy, and the
    supplier's net -- which is recoverable from a priced response because
    charged = net * (1 + margin/100) is the verified margin law.
    """
    out = {}
    sup = set()
    for entry in data or []:
        for rt in entry.get("roomTypes") or []:
            if rt.get("rateType") == "package":
                continue
            amt = (rt.get("offerRetailRate") or {}).get("amount")
            if amt is None:
                continue
            net = amt / (1 + margin / 100)
            ra = (rt.get("rates") or [{}])[0]
            cp = ra.get("cancellationPolicies") or {}
            sid = rt.get("supplierId") or rt.get("supplier")
            sup.add(sid)
            # The key deliberately EXCLUDES price. A first pass included net to
            # the cent and made the priced arms look catastrophic (21% vs 93%),
            # but that was arithmetic, not churn: margin-0 nets are exact while
            # a priced net is amount/1.12 and lands a cent either side. Identity
            # is supplier + physical room + board + refund policy; whether the
            # price MOVED is a separate measurement below, with a tolerance.
            key = (
                sid,
                ra.get("mappedRoomId") or rt.get("roomTypeId"),
                (ra.get("boardName") or "").strip().lower(),
                cp.get("refundableTag"),
            )
            # Same key can arrive twice from different plans; keep the cheapest,
            # which is the one that would set the price we show.
            out[key] = min(net, out.get(key, net))
    return out, sup


def jaccard(a: set, b: set) -> float:
    return len(a & b) / len(a | b) if (a or b) else 1.0


def arm(name: str, hotel: str, ci: date, m1: int, s1: str | None, m2: int, s2: str | None):
    d1, t1, e1 = rates(hotel, ci, m1, s1)
    d2, t2, e2 = rates(hotel, ci, m2, s2)
    if e1 or e2:
        print(f"    {name:<8} FAIL {e1 or e2}")
        return None
    o1, sup1 = offers(d1, m1)
    o2, sup2 = offers(d2, m2)

    # Of the suppliers the margin was computed from, how many still answer?
    kept = len(sup1 & sup2) / len(sup1) if sup1 else 0.0
    # Did the plans that survived keep the same net? A supplier that answers
    # both calls but requotes is just as damaging as one that vanishes.
    common_ids = set(o1) & set(o2)
    # A cent of float drift from dividing out the margin is not a requote.
    requoted = sum(1 for k in common_ids if abs(o1[k] - o2[k]) > 0.02)
    worst = max((abs(o1[k] - o2[k]) for k in common_ids), default=0.0)

    cheap1 = min(o1.values()) if o1 else None
    cheap2 = min(o2.values()) if o2 else None
    cheap_moved = (
        None if cheap1 is None or cheap2 is None else round(cheap2 - cheap1, 2)
    )

    print(
        f"    {name:<8} suppliers {len(sup1):>2}->{len(sup2):<2} kept {kept:5.0%}  "
        f"jaccard(sup) {jaccard(sup1, sup2):5.0%}  jaccard(plans) {jaccard(set(o1), set(o2)):5.0%}  "
        f"plans {len(o1):>3}->{len(o2):<3} requoted {requoted:>3}/{len(common_ids):<3} "
        f"(worst ${worst:.2f})  "
        f"cheapest net {cheap1 if cheap1 is None else round(cheap1,2)}->"
        f"{cheap2 if cheap2 is None else round(cheap2,2)} ({cheap_moved})  "
        f"{t1:.1f}s+{t2:.1f}s"
    )
    return {
        "arm": name,
        "hotel": hotel,
        "checkin": ci.isoformat(),
        "suppliers_in": len(sup1),
        "suppliers_out": len(sup2),
        "supplier_kept": kept,
        "supplier_jaccard": jaccard(sup1, sup2),
        "plan_jaccard": jaccard(set(o1), set(o2)),
        "plans_in": len(o1),
        "plans_out": len(o2),
        "requoted": requoted,
        "common": len(common_ids),
        "worst_requote": worst,
        "cheapest_in": cheap1,
        "cheapest_out": cheap2,
    }


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--hotels", default="lp85c07,lp1b919,lp225d01,lp40992")
    p.add_argument("--margin", type=int, default=12)
    args = p.parse_args()
    hotels = [h.strip() for h in args.hotels.split(",") if h.strip()]

    print(f"sessionId supplier-pinning test   margin {args.margin}%   "
          f"cap {RATE_FETCH_CAP}   timeout {TIMEOUT_S}s")
    print("every call on a unique check-in date, so nothing is served from cache\n")

    rows = []
    day = 40
    for h in hotels:
        print(f"  {h}")
        for name, m1, s1, m2, s2 in [
            ("CONTROL", 0, uuid.uuid4().hex, 0, uuid.uuid4().hex),
            ("LOOSE", 0, None, args.margin, None),
            ("PINNED", 0, None, args.margin, None),  # session filled in below
        ]:
            if name == "PINNED":
                s = uuid.uuid4().hex
                s1 = s2 = s
            r = arm(name, h, date.today() + timedelta(days=day), m1, s1, m2, s2)
            day += 1
            if r:
                rows.append(r)
        print()

    print("-" * 78)
    print(f"{'arm':<9}{'supplier kept':>15}{'supplier jaccard':>19}"
          f"{'plan jaccard':>15}{'requoted':>11}")
    for name in ("CONTROL", "LOOSE", "PINNED"):
        rs = [r for r in rows if r["arm"] == name]
        if not rs:
            continue
        req = sum(r["requoted"] for r in rs)
        com = sum(r["common"] for r in rs)
        print(
            f"{name:<9}{statistics.mean(r['supplier_kept'] for r in rs):>14.0%}"
            f"{statistics.mean(r['supplier_jaccard'] for r in rs):>19.0%}"
            f"{statistics.mean(r['plan_jaccard'] for r in rs):>15.0%}"
            f"{f'{req}/{com}':>11}"
        )
    print("-" * 78)
    print("CONTROL is the floor: churn with margin held constant. LOOSE is what the")
    print("app does today. PINNED adopts sessionId. sessionId is worth adopting only")
    print("if PINNED beats LOOSE by more than the spread inside CONTROL.")

    out = HERE / "session-pin.json"
    out.write_text(json.dumps(rows, indent=1), encoding="utf-8")
    print(f"\nraw -> {out}")


if __name__ == "__main__":
    main()
