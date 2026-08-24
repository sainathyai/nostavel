#!/usr/bin/env python
"""Where does our margin sit, and is it taxed?

The open questions, stated precisely:

  1. When `margin` rises, does `retailRate.total` rise by exactly the margin on
     the NET rate, or by the margin on the tax-inclusive amount?
  2. Do the INCLUDED tax lines change with margin? If they hold constant while
     the total rises, the tax was computed on the net rate and our margin sits
     on top of it, untaxed. If they scale, the guest is being charged tax on our
     commission.
  3. Do the EXCLUDED lines (hotel-collected) change with margin? They should
     not: the hotel levies its own tax on its own rate and has no knowledge of
     our markup.
  4. What does `commission` report, and does it equal total(m) - total(0)?
  5. Does prebook charge the marked-up total, i.e. is the whole margin actually
     collected from the guest by LiteAPI?

Method: the same plan is priced at several margins and compared field by field.
`offerId` does not survive a margin change (measured: 0/50 match), so plans are
matched on (mappedRoomId, rate name, boardType, refundableTag) — identity that
does survive — and only plans present in EVERY response are compared, so no
conclusion rests on a plan that a supplier happened to drop that second.

    python analysis/2026-08-19/margin_itemize.py
    python analysis/2026-08-19/margin_itemize.py --hotels lp225d01 --keys 8
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from collections import defaultdict
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

MARGINS = [0, 10, 20, 30]


def post(path: str, body: dict) -> dict:
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode(),
        headers={"X-API-Key": KEY, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read().decode())


def rule(t: str) -> None:
    print(f"\n{'=' * 100}\n{t}\n{'=' * 100}")


def plans(resp: dict) -> dict:
    """Index every plan by identity that survives a margin change."""
    out = {}
    for entry in resp.get("data") or []:
        for rt in entry.get("roomTypes") or []:
            for ra in rt.get("rates") or []:
                rr = ra.get("retailRate") or {}
                total = ((rr.get("total") or [{}])[0]).get("amount")
                if total is None:
                    continue
                key = (
                    entry.get("hotelId"),
                    ra.get("mappedRoomId"),
                    ra.get("name"),
                    ra.get("boardType"),
                    (ra.get("cancellationPolicies") or {}).get("refundableTag"),
                )
                tf = rr.get("taxesAndFees") or []
                # Keep the CHEAPEST plan per identity: several suppliers can
                # answer for the same room, and mixing them across margins would
                # compare two different contracts and blame the difference on
                # the markup.
                cand = {
                    "total": total,
                    "offerTotal": (rt.get("offerRetailRate") or {}).get("amount"),
                    "offerId": rt.get("offerId"),
                    "inc": {f.get("description"): f.get("amount") for f in tf if f.get("included")},
                    "exc": {f.get("description"): f.get("amount") for f in tf if not f.get("included")},
                    "incSum": round(sum(f.get("amount") or 0 for f in tf if f.get("included")), 2),
                    "excSum": round(sum(f.get("amount") or 0 for f in tf if not f.get("included")), 2),
                    "ssp": ((rr.get("suggestedSellingPrice") or [{}])[0]).get("amount"),
                    "initial": ((rr.get("initialPrice") or [{}])[0]).get("amount"),
                    "commission": ((ra.get("commission") or [{}])[0]).get("amount"),
                    "providerCommission": (ra.get("providerCommission") or {}).get("amount"),
                    "priceType": ra.get("priceType"),
                }
                if key not in out or cand["total"] < out[key]["total"]:
                    out[key] = cand
    return out


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--hotels", default="lp225d01,lp1b919,lp40992")
    p.add_argument("--checkin", default="2026-10-13")
    p.add_argument("--checkout", default="2026-10-15")
    p.add_argument("--keys", type=int, default=4)
    p.add_argument("--cap", type=int, default=300)
    args = p.parse_args()

    ids = [x.strip() for x in args.hotels.split(",") if x.strip()]
    by_margin: dict[int, dict] = {}
    for m in MARGINS:
        resp = post(
            "/hotels/rates",
            {
                "hotelIds": ids,
                "occupancies": [{"adults": 2}],
                "currency": "USD",
                "guestNationality": "US",
                "checkin": args.checkin,
                "checkout": args.checkout,
                "maxRatesPerHotel": args.cap,
                "timeout": 30,
                "margin": m,
                "roomMapping": True,
            },
        )
        by_margin[m] = plans(resp)
        print(f"margin {m:>3}: {len(by_margin[m])} distinct plans")

    common = set.intersection(*(set(v) for v in by_margin.values()))
    print(f"\n{len(common)} plans present at EVERY margin (the only fair comparison set)")

    # Prefer plans that actually have both included and excluded lines: they are
    # the ones where the question has teeth.
    ranked = sorted(
        common,
        key=lambda k: (
            -(by_margin[0][k]["incSum"] > 0) - (by_margin[0][k]["excSum"] > 0),
            by_margin[0][k]["total"],
        ),
    )

    verdicts = defaultdict(int)
    for key in ranked[: args.keys]:
        hid, mapped, name, board, refund = key
        base = by_margin[0][key]
        rule(f"{hid}  mappedRoom {mapped}  {str(name)[:52]}  [{board}/{refund}]")
        print(f"  net (margin 0 total)   {base['total']:.2f}")
        print(f"  included lines         {base['inc']}")
        print(f"  excluded lines         {base['exc']}")
        print()
        print(f"  {'margin':>7} {'total':>10} {'delta':>9} {'delta%':>8} "
              f"{'incTax':>9} {'excl':>9} {'commission':>11} {'ssp':>9}")
        for m in MARGINS:
            r = by_margin[m][key]
            delta = r["total"] - base["total"]
            pct = delta / base["total"] * 100 if base["total"] else 0
            print(f"  {m:>7} {r['total']:>10.2f} {delta:>9.2f} {pct:>7.2f}% "
                  f"{r['incSum']:>9.2f} {r['excSum']:>9.2f} "
                  f"{str(r['commission']):>11} {str(r['ssp']):>9}")

        # --- the actual verdicts, computed not eyeballed ---
        top = by_margin[MARGINS[-1]][key]
        m = MARGINS[-1]
        on_net = base["total"] * (1 + m / 100)
        on_net_excl_tax = (base["total"] - base["incSum"]) * (1 + m / 100) + base["incSum"]
        if abs(top["total"] - on_net) < 0.02:
            verdicts["margin applies to the FULL total, tax included"] += 1
            print(f"\n  -> total({m}) = {top['total']:.2f} = net x {1 + m/100:.2f}: the markup is "
                  f"taken on the whole tax-inclusive rate")
        elif abs(top["total"] - on_net_excl_tax) < 0.02:
            verdicts["margin applies to the room only, tax untouched"] += 1
            print(f"\n  -> total({m}) = {top['total']:.2f} = (net - tax) x {1 + m/100:.2f} + tax: "
                  f"the markup skips the tax")
        else:
            verdicts["neither model"] += 1
            print(f"\n  -> total({m}) = {top['total']:.2f}, on-net {on_net:.2f}, "
                  f"on-room-only {on_net_excl_tax:.2f}  <-- NEITHER")

        inc_moved = abs(top["incSum"] - base["incSum"]) > 0.005
        exc_moved = abs(top["excSum"] - base["excSum"]) > 0.005
        print(f"  -> included tax lines {'CHANGED' if inc_moved else 'held constant'} "
              f"({base['incSum']:.2f} -> {top['incSum']:.2f})")
        print(f"  -> excluded lines     {'CHANGED' if exc_moved else 'held constant'} "
              f"({base['excSum']:.2f} -> {top['excSum']:.2f})")
        verdicts["included tax scales with margin" if inc_moved
                 else "included tax fixed on net"] += 1
        verdicts["excluded scales with margin" if exc_moved
                 else "excluded fixed on net"] += 1
        print(f"  -> commission field   {base['commission']} -> {top['commission']}   "
              f"(total delta {top['total'] - base['total']:.2f})")

        # --- what is actually charged: prebook the marked-up offer ---
        try:
            pb = (post("/rates/prebook", {"offerId": top["offerId"], "usePaymentSdk": True})
                  .get("data") or {})
            print(f"  -> PREBOOK at margin {m}: price {pb.get('price')}  "
                  f"commission {pb.get('commission')}  "
                  f"ssp {pb.get('suggestedSellingPrice')}  "
                  f"diff% {pb.get('priceDifferencePercent')}")
            pbtf = (((pb.get("roomTypes") or [{}])[0].get("rates") or [{}])[0]
                    .get("retailRate") or {}).get("taxesAndFees")
            print(f"     prebook taxesAndFees: {json.dumps(pbtf)}")
        except urllib.error.HTTPError as e:
            print(f"  -> PREBOOK at margin {m}: HTTP {e.code} {e.read().decode()[:90]}")

    rule("VERDICT TALLY")
    for k, v in sorted(verdicts.items(), key=lambda x: -x[1]):
        print(f"  {v:>3}  {k}")

    # ---------------------------------------------------------------------
    # The cross-call comparison above has one weakness: the NET rate itself
    # drifts between calls, because each call is a fresh supplier fan-out. A
    # plan whose commission (167.54) exceeds its price rise (160.75) has not
    # broken the model — it was quoted a cheaper net that second.
    #
    # This check needs no stable net. Within ONE response, if the model is
    #     total = net x (1 + margin)  and  commission = total - net
    # then  (total - commission) x (1 + margin) == total,  which is checkable
    # per plan, per margin, against nothing but itself.
    # ---------------------------------------------------------------------
    rule("SELF-CONSISTENCY: does (total - commission) x (1 + margin) == total?")
    print(f"  {'margin':>7} {'plans':>7} {'holds':>7} {'max error':>11}   implied net vs commission")
    for m in MARGINS:
        held = 0
        worst = 0.0
        n = 0
        for key, r in by_margin[m].items():
            c = r["commission"]
            if c is None or r["total"] is None:
                continue
            n += 1
            implied_net = r["total"] - c
            err = abs(implied_net * (1 + m / 100) - r["total"])
            worst = max(worst, err)
            # Cents-level tolerance: LiteAPI rounds inside its own pipeline
            # (margin 20 lands at 19.99%, not 20.00%), so an exact-equality test
            # would report a broken model when the model is fine.
            if err < 0.15:
                held += 1
        print(f"  {m:>7} {n:>7} {held:>7} {worst:>11.4f}")

    # And what the guest is charged vs what reaches us, itemized once cleanly.
    rule("ITEMIZED: one plan, every number, at our production margin")
    key = ranked[0]
    for m in MARGINS:
        r = by_margin[m][key]
        net = r["total"] - (r["commission"] or 0)
        room = net - r["incSum"]
        print(f"\n  margin {m}%")
        print(f"    supplier room rate (net of tax)      {room:>9.2f}")
        print(f"    tax inside the rate                  {r['incSum']:>9.2f}")
        print(f"    = supplier net total                 {net:>9.2f}")
        print(f"    our margin on that whole amount      {(r['commission'] or 0):>9.2f}")
        print(f"    = CHARGED BY LITEAPI TO THE GUEST    {r['total']:>9.2f}")
        print(f"    collected separately by the hotel    {r['excSum']:>9.2f}")
        print(f"    = guest's all-in cost                {r['total'] + r['excSum']:>9.2f}")
        print(f"    tax DISCLOSED to the guest           {r['incSum']:>9.2f}"
              f"   (unchanged by our margin)")
        if r["incSum"] and m:
            print(f"    of our margin, the part sitting on tax "
                  f"{r['incSum'] * m / 100:>7.2f}   (earned on the tax, not remitted as tax)")


if __name__ == "__main__":
    main()
