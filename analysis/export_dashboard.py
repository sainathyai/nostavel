#!/usr/bin/env python
"""Export a full rate-plan dataset for the developer dashboard.

Deliberately does NO filtering and NO judgement: package rates, placeholder
SSPs and unmatched rooms are all kept, each with a column saying what they are.
The dashboard is for deciding what the rules should be, so it must not ship
with those rules already applied.

Uses timeout 30 (not 12) after measuring that the shorter window silently drops
slow suppliers and never surfaced the cheapest plan: at timeout 12 the cheapest
standard rate was $764.25 on 3/3 runs, at timeout 30 it was $748.65 on 3/3, and
the longer timeout was FASTER (3.4s vs 4.4-5.1s).

    python analysis/export_dashboard.py --hotels 4
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).parent
BASE = "https://api.liteapi.travel/v3.0"
KEY = [l.partition("=")[2].strip().strip("\"'")
       for l in (HERE.parent / ".env.local").read_text(encoding="utf-8").splitlines()
       if l.startswith("LITEAPI_KEY")][0]

MIN_MARGIN, MAX_MARGIN, BASE_MARGIN, MIN_SAVE = 5.0, 30.0, 12.0, 0.10


def post(path, body):
    req = urllib.request.Request(f"{BASE}{path}", data=json.dumps(body).encode(),
                                 headers={"X-API-Key": KEY, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read().decode())


def get(path, params):
    q = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items())
    req = urllib.request.Request(f"{BASE}{path}?{q}", headers={"X-API-Key": KEY})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode())


# Wording rules mirror src/lib/fees.ts — a fee is never called a tax.
TAXY = re.compile(r"tax|lodging|occupanc|vat|government|municipal|tourism", re.I)
FEEY = re.compile(r"resort|destination|amenity|facilit|clean|service|parking", re.I)


def fee_kind(desc: str) -> str:
    d = (desc or "").strip()
    if not d or re.fullmatch(r"others?|fees?", d, re.I):
        return "unspecified"
    if FEEY.search(d):
        return "fee"
    if TAXY.search(d):
        return "tax"
    return "unspecified"


VIEW = re.compile(r"view|balcon|terrace|ocean|river|city\s*view|pool\s*view", re.I)
ACC = re.compile(r"accessib|mobility|hearing|roll-?in|visual|disabilit|\bada\b", re.I)
SUITE = re.compile(r"suite|studio|apartment|penthouse", re.I)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--city", default="Asheville")
    p.add_argument("--lat", type=float, default=35.5951)
    p.add_argument("--lng", type=float, default=-82.5515)
    p.add_argument("--radius", type=int, default=12000)
    p.add_argument("--hotels", type=int, default=4)
    p.add_argument("--checkin", default="2026-09-18")
    p.add_argument("--checkout", default="2026-09-20")
    p.add_argument("--nights", type=int, default=2)
    p.add_argument("--cap", type=int, default=5000)
    p.add_argument("--timeout", type=int, default=30)
    args = p.parse_args()

    listing = (get("/data/hotels", {"latitude": args.lat, "longitude": args.lng,
                                    "radius": args.radius, "limit": args.hotels * 3}) or {}).get("data") or []
    names = {h["id"]: h.get("name") or h["id"] for h in listing}
    ids = [h["id"] for h in listing][: args.hotels]
    print(f"pulling {len(ids)} hotels at cap {args.cap}, timeout {args.timeout}")

    rows = []
    for hid in ids:
        try:
            d = post("/hotels/rates", {
                "hotelIds": [hid], "occupancies": [{"adults": 2}], "currency": "USD",
                "guestNationality": "US", "checkin": args.checkin, "checkout": args.checkout,
                "maxRatesPerHotel": args.cap, "margin": 0, "timeout": args.timeout,
            }).get("data") or []
        except Exception as exc:  # noqa: BLE001
            print(f"  {hid}: FAILED {exc}")
            continue
        if not d:
            print(f"  {hid}: no rates")
            continue
        n = 0
        for rt in d[0].get("roomTypes") or []:
            for rate in rt.get("rates") or []:
                rr = rate.get("retailRate") or {}
                net = ((rr.get("total") or [{}])[0]).get("amount")
                if net is None:
                    continue
                sspd = (rr.get("suggestedSellingPrice") or [{}])[0]
                ssp, src = sspd.get("amount"), (sspd.get("source") or "")
                tf = rr.get("taxesAndFees") or []
                inc = [f for f in tf if f.get("included")]
                exc = [f for f in tf if not f.get("included")]
                incSum = round(sum(f.get("amount") or 0 for f in inc), 2)
                excSum = round(sum(f.get("amount") or 0 for f in exc), 2)
                cp = rate.get("cancellationPolicies") or {}
                nm = rate.get("name") or ""
                board = rate.get("boardName") or ""

                # SSP is evidence only when sourced; unsourced tracks the
                # net*1.15 placeholder.
                realSsp = bool(ssp and src.strip() and abs(ssp / net - 1.15) >= 0.005)
                if realSsp:
                    ceil = ((ssp * (1 - MIN_SAVE)) / net - 1) * 100
                    margin = max(MIN_MARGIN, min(BASE_MARGIN, ceil, MAX_MARGIN))
                else:
                    margin = BASE_MARGIN
                ourPrice = math.ceil(round(net * (1 + margin / 100) * 100) / 100)

                rows.append({
                    "hotelId": hid,
                    "hotel": names.get(hid, hid),
                    "room": nm,
                    "rateType": rt.get("rateType") or "",
                    "board": board,
                    "breakfast": bool(re.search(r"breakfast|bed and|half board|full board", board, re.I)),
                    "view": bool(VIEW.search(nm)),
                    "accessible": bool(ACC.search(nm)),
                    "suite": bool(SUITE.search(nm)),
                    "refundable": cp.get("refundableTag") == "RFN",
                    "cancelBy": ((cp.get("cancelPolicyInfos") or [{}])[0]).get("cancelTime") or "",
                    "net": round(net, 2),
                    "incFees": [{"d": f.get("description") or "", "a": f.get("amount") or 0,
                                 "k": fee_kind(f.get("description") or "")} for f in inc],
                    "incSum": incSum,
                    # Summing unlike charges hides the answer: an "includes"
                    # of $103.75 that is $62.72 tax + $41.03 ExtraPersonCharge
                    # looks like a different tax rate than a plan whose $72.17
                    # is pure tax, when both are charged at exactly 13%. Keep
                    # tax and non-tax apart everywhere.
                    "incTax": round(sum(f.get("amount") or 0 for f in inc
                                        if fee_kind(f.get("description") or "") == "tax"), 2),
                    "incOther": round(sum(f.get("amount") or 0 for f in inc
                                          if fee_kind(f.get("description") or "") != "tax"), 2),
                    "excTax": round(sum(f.get("amount") or 0 for f in exc
                                        if fee_kind(f.get("description") or "") == "tax"), 2),
                    "excOther": round(sum(f.get("amount") or 0 for f in exc
                                          if fee_kind(f.get("description") or "") != "tax"), 2),
                    "excFees": [{"d": f.get("description") or "", "a": f.get("amount") or 0,
                                 "k": fee_kind(f.get("description") or "")} for f in exc],
                    "excSum": excSum,
                    # net ALREADY contains incSum; allIn adds what the property collects.
                    "allInNet": round(net + excSum, 2),
                    # net already contains any INCLUDED tax, so the base the
                    # tax was levied on is net minus that. Other charges
                    # (extra person, resort) ARE part of the base: verified on
                    # two plans that looked like different rates and were both
                    # exactly 13.00% once computed this way.
                    "taxBase": round(net - sum(f.get("amount") or 0 for f in inc
                                               if fee_kind(f.get("description") or "") == "tax"), 2),
                    "taxRate": None,
                    "ssp": round(ssp, 2) if ssp else None,
                    "sspSource": src,
                    "realSsp": realSsp,
                    "spread": round(ssp / net, 4) if ssp else None,
                    "margin": round(margin, 2),
                    "ourPrice": ourPrice,
                    "guestAllIn": round(ourPrice + excSum, 2),
                    # LiteAPI reports supplier "nuitee" / supplierId 2 on every
                    # rate, and the offerId msgpack carries the same single
                    # sid=2 — the upstream wholesaler is deliberately not
                    # exposed. The fee-description vocabulary is the only
                    # observable fingerprint: each wholesaler has its own
                    # schema and LiteAPI passes the strings through unnormalised
                    # ("Tax Recovery Charges & Service Fees" is Expedia/EAN's
                    # standard wording, "TaxPercent"+"ExtraPersonCharge"
                    # another vendor's field naming). Inferential, not
                    # authoritative — treat as a grouping key, never as a fact
                    # about who is selling.
                    "feeVocab": " + ".join(
                        sorted((f.get("description") or "?").strip() or "?" for f in tf)
                    ) or "(none)",
                    "supplier": rt.get("supplier") or "",
                    "supplierId": rt.get("supplierId"),
                    "payment": ",".join(rate.get("paymentTypes") or []),
                    "priceType": rate.get("priceType") or "",
                    "maxOcc": rate.get("maxOccupancy"),
                })
                r = rows[-1]
                totTax = r["incTax"] + r["excTax"]
                r["taxRate"] = round(totTax / r["taxBase"] * 100, 2) if r["taxBase"] > 0 else None
                n += 1
        print(f"  {hid}: {n} plans  ({names.get(hid, '')[:44]})")

    meta = {
        "city": args.city, "checkin": args.checkin, "checkout": args.checkout,
        "nights": args.nights, "cap": args.cap, "timeout": args.timeout,
        "hotels": len(ids), "plans": len(rows),
        "baseMargin": BASE_MARGIN, "minMargin": MIN_MARGIN, "maxMargin": MAX_MARGIN,
    }
    out = HERE / "dashboard-data.json"
    out.write_text(json.dumps({"meta": meta, "rows": rows}, separators=(",", ":")),
                   encoding="utf-8")
    print(f"\nwrote {out}  ({out.stat().st_size / 1024:.0f} KB, {len(rows)} rows)")


if __name__ == "__main__":
    main()
