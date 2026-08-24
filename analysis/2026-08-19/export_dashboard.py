#!/usr/bin/env python
"""Export the mapped rate set for the dashboard.

Differs from the 2026-08-18 export in one decisive way: `roomMapping: true`.
That turns LiteAPI's raw supplier fan-out into a deduplicated set and adds
`mappedRoomId`, the only field that reconciles the same physical room across
suppliers. Measured on Hilton NOLA, same dates and cap:

    roomMapping false -> 5000 plans, 17.2 MB, cheapest 340.22 (once 344.10)
    roomMapping true  ->  135 plans,  0.5 MB, cheapest 340.22

Still no filtering here: package rates, placeholder SSPs and unlabelled fees
all stay, each tagged. The dashboard is for deciding the rules, so it must not
ship with them applied.

    python analysis/2026-08-19/export_dashboard.py --hotels 6
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).resolve().parent
BASE = "https://api.liteapi.travel/v3.0"
KEY = [l.partition("=")[2].strip().strip("\"'")
       for l in (HERE.parent.parent / ".env.local").read_text(encoding="utf-8").splitlines()
       if l.startswith("LITEAPI_KEY")][0]

MIN_MARGIN, MAX_MARGIN, BASE_MARGIN, MIN_SAVE = 5.0, 30.0, 12.0, 0.10

TAXY = re.compile(r"tax|lodging|occupanc|vat|government|municipal|tourism", re.I)
FEEY = re.compile(r"resort|destination|amenity|facilit|clean|service|parking", re.I)
VIEW = re.compile(r"view|balcon|terrace|ocean|river|city\s*view|pool\s*view", re.I)
ACC = re.compile(r"accessib|mobility|hearing|roll-?in|visual|disabilit|\bada\b", re.I)
SUITE = re.compile(r"suite|studio|apartment|penthouse", re.I)


def fee_kind(desc: str) -> str:
    d = (desc or "").strip()
    if not d or re.fullmatch(r"others?|fees?", d, re.I):
        return "unspecified"
    if FEEY.search(d):
        return "fee"
    if TAXY.search(d):
        return "tax"
    return "unspecified"


def post(path, body):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(),
                                 headers={"X-API-Key": KEY, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read().decode())


def get(path, params):
    q = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items())
    req = urllib.request.Request(f"{BASE}{path}?{q}", headers={"X-API-Key": KEY})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode())


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--city", default="Asheville")
    p.add_argument("--lat", type=float, default=35.5951)
    p.add_argument("--lng", type=float, default=-82.5515)
    p.add_argument("--radius", type=int, default=12000)
    p.add_argument("--hotels", type=int, default=6)
    p.add_argument("--checkin", default="2026-10-13")
    p.add_argument("--checkout", default="2026-10-15")
    p.add_argument("--nights", type=int, default=2)
    p.add_argument("--cap", type=int, default=5000)
    p.add_argument("--timeout", type=int, default=30)
    args = p.parse_args()

    listing = (get("/data/hotels", {"latitude": args.lat, "longitude": args.lng,
                                    "radius": args.radius, "limit": args.hotels * 3}) or {}).get("data") or []
    names = {h["id"]: h.get("name") or h["id"] for h in listing}
    ids = [h["id"] for h in listing][: args.hotels]
    print(f"pulling {len(ids)} hotels · roomMapping=true · cap {args.cap} · timeout {args.timeout}s")

    rows = []
    for hid in ids:
        try:
            d = post("/hotels/rates", {
                "hotelIds": [hid], "occupancies": [{"adults": 2}], "currency": "USD",
                "guestNationality": "US", "checkin": args.checkin, "checkout": args.checkout,
                "maxRatesPerHotel": args.cap, "timeout": args.timeout, "margin": 0,
                "roomMapping": True, "includeHotelData": True,
            }).get("data") or []
        except urllib.error.HTTPError as e:
            print(f"  {hid}: HTTP {e.code}")
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
                incTax = round(sum(f.get("amount") or 0 for f in inc
                                   if fee_kind(f.get("description") or "") == "tax"), 2)
                incOther = round(sum(f.get("amount") or 0 for f in inc
                                     if fee_kind(f.get("description") or "") != "tax"), 2)
                excTax = round(sum(f.get("amount") or 0 for f in exc
                                   if fee_kind(f.get("description") or "") == "tax"), 2)
                excOther = round(sum(f.get("amount") or 0 for f in exc
                                     if fee_kind(f.get("description") or "") != "tax"), 2)
                excSum = round(excTax + excOther, 2)
                cp = rate.get("cancellationPolicies") or {}
                nm = rate.get("name") or ""
                board = rate.get("boardName") or ""

                realSsp = bool(ssp and src.strip() and abs(ssp / net - 1.15) >= 0.005)
                if realSsp:
                    ceil = ((ssp * (1 - MIN_SAVE)) / net - 1) * 100
                    margin = max(MIN_MARGIN, min(BASE_MARGIN, ceil, MAX_MARGIN))
                else:
                    margin = BASE_MARGIN
                ourPrice = math.ceil(round(net * (1 + margin / 100) * 100) / 100)
                taxBase = round(net - incTax, 2)

                rows.append({
                    "hotelId": hid,
                    "hotel": names.get(hid, hid),
                    # The whole point of this pull: one physical room across suppliers.
                    "mappedRoomId": str(rate.get("mappedRoomId")
                                        or rt.get("mappedRoomId") or ""),
                    "room": nm,
                    "roomTypeId": rt.get("roomTypeId") or "",
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
                    "incTax": incTax, "incOther": incOther,
                    "excFees": [{"d": f.get("description") or "", "a": f.get("amount") or 0,
                                 "k": fee_kind(f.get("description") or "")} for f in exc],
                    "excTax": excTax, "excOther": excOther,
                    "incSum": round(incTax + incOther, 2), "excSum": excSum,
                    "allInNet": round(net + excSum, 2),
                    "taxBase": taxBase,
                    "taxRate": round((incTax + excTax) / taxBase * 100, 2) if taxBase > 0 else None,
                    "ssp": round(ssp, 2) if ssp else None,
                    "sspSource": src, "realSsp": realSsp,
                    "spread": round(ssp / net, 4) if ssp else None,
                    "margin": round(margin, 2),
                    "ourPrice": ourPrice,
                    "guestAllIn": round(ourPrice + excSum, 2),
                    "feeVocab": " + ".join(sorted((f.get("description") or "?").strip() or "?"
                                                  for f in tf)) or "(none)",
                    "supplier": rt.get("supplier") or "",
                    "supplierId": rt.get("supplierId"),
                    "payment": ",".join(rate.get("paymentTypes") or []),
                    "maxOcc": rate.get("maxOccupancy"),
                })
                n += 1
        mapped = len({r["mappedRoomId"] for r in rows if r["hotelId"] == hid})
        print(f"  {hid}: {n:>4} plans -> {mapped:>3} mapped rooms   {names.get(hid,'')[:40]}")

    meta = {"city": args.city, "checkin": args.checkin, "checkout": args.checkout,
            "nights": args.nights, "cap": args.cap, "timeout": args.timeout,
            "roomMapping": True, "hotels": len(ids), "plans": len(rows),
            "baseMargin": BASE_MARGIN, "minMargin": MIN_MARGIN, "maxMargin": MAX_MARGIN}
    out = HERE / "dashboard-data.json"
    out.write_text(json.dumps({"meta": meta, "rows": rows}, separators=(",", ":")), encoding="utf-8")
    print(f"\nwrote {out.name}  ({out.stat().st_size/1024:.0f} KB, {len(rows)} rows, "
          f"{len({r['mappedRoomId'] for r in rows})} distinct mapped rooms)")


if __name__ == "__main__":
    main()
