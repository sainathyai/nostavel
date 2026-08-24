#!/usr/bin/env python
"""What IS the money we tell the guest to pay at the property?

Calling a variable charge "tax" is not a cosmetic problem: a resort or
destination fee is a merchant charge, a tax is a government levy, and
mislabelling one as the other is a consumer-protection issue (US FTC junk-fee
rule, and several state AG actions have turned on exactly this wording). So
this script refuses to guess. It establishes three things from evidence:

  1. BASIS      does the amount scale with nights? Same hotel, same rooms,
                2 nights vs 4. If it doubles it is per-night and our stay
                total is currently wrong; if flat it is per-stay.
  2. VOCABULARY every distinct `description` string the supplier actually
                sends, with counts, so the label map is built from the real
                domain rather than from six guesses.
  3. CORROBORATION does /data/hotel carry a policy/fee block that names the
                same charge in prose we can trust?

    python analysis/fees.py --hotels 12
    python analysis/fees.py --ids lp225d01 --verbose
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.request
from collections import Counter, defaultdict
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


def post(path: str, body: dict) -> dict:
    req = urllib.request.Request(
        f"{BASE}{path}", data=json.dumps(body).encode(),
        headers={"X-API-Key": KEY, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read().decode())


def get(path: str, params: dict) -> dict:
    q = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items())
    req = urllib.request.Request(f"{BASE}{path}?{q}", headers={"X-API-Key": KEY})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode())


def rates(ids, checkin, checkout, cap, margin=0):
    return post("/hotels/rates", {
        "hotelIds": ids, "occupancies": [{"adults": 2}], "currency": "USD",
        "guestNationality": "US", "checkin": checkin, "checkout": checkout,
        "maxRatesPerHotel": cap, "margin": margin, "timeout": 12,
    }).get("data") or []


def fee_rows(entries, nights):
    out = []
    for e in entries:
        for rt in e.get("roomTypes") or []:
            for rate in rt.get("rates") or []:
                rr = rate.get("retailRate") or {}
                for f in rr.get("taxesAndFees") or []:
                    out.append({
                        "hotelId": e.get("hotelId"),
                        "nights": nights,
                        "room": rate.get("name") or "",
                        "rateType": rt.get("rateType"),
                        "included": bool(f.get("included")),
                        "description": (f.get("description") or "").strip(),
                        "amount": f.get("amount"),
                        "currency": f.get("currency"),
                    })
    return out


def rule(t):
    print(f"\n{'=' * 88}\n{t}\n{'=' * 88}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--city", default="Asheville")
    p.add_argument("--country", default="US")
    p.add_argument("--ids", default=None)
    p.add_argument("--hotels", type=int, default=12)
    p.add_argument("--checkin", default="2026-09-18")
    p.add_argument("--cap", type=int, default=60)
    p.add_argument("--verbose", action="store_true")
    args = p.parse_args()

    if args.ids:
        ids = [x.strip() for x in args.ids.split(",") if x.strip()]
    else:
        found = post("/hotels/rates", {
            "cityName": args.city, "countryCode": args.country, "limit": 200,
            "occupancies": [{"adults": 2}], "currency": "USD", "guestNationality": "US",
            "checkin": args.checkin, "checkout": "2026-09-20",
            "maxRatesPerHotel": 1, "margin": 0, "timeout": 12,
        }).get("data") or []
        ids = [e["hotelId"] for e in found][: args.hotels]
        print(f"{len(found)} hotels in {args.city}; using {len(ids)}")

    # ---------------------------------------------------------------- 1. BASIS
    rule("1. BASIS — does the charge scale with length of stay?")
    print("Same hotels, same check-in, 2 nights vs 4. A per-stay fee is flat;")
    print("a per-night fee doubles. Matched on (hotel, room name, description).\n")
    short = fee_rows(rates(ids, args.checkin, "2026-09-20", args.cap), 2)
    long_ = fee_rows(rates(ids, args.checkin, "2026-09-22", args.cap), 4)
    d = pd.DataFrame(short + long_)
    if d.empty:
        raise SystemExit("no fee data returned")

    key = ["hotelId", "room", "description", "included"]
    piv = d.groupby(key + ["nights"])["amount"].min().unstack("nights")
    piv = piv.dropna()
    if {2, 4} <= set(piv.columns):
        piv["ratio"] = (piv[4] / piv[2]).round(3)
        piv = piv[piv[2] > 0]

        def basis(r):
            if abs(r - 1.0) < 0.02:
                return "PER STAY (flat)"
            if abs(r - 2.0) < 0.05:
                return "PER NIGHT (doubled)"
            return "other"

        piv["basis"] = piv["ratio"].apply(basis)
        print(piv["basis"].value_counts().to_string())
        print("\nby description:")
        bd = piv.reset_index().groupby(["description", "basis"]).size().unstack(fill_value=0)
        print(bd.to_string())
        odd = piv[piv["basis"] == "other"]
        if len(odd):
            print(f"\n{len(odd)} charges scale on neither basis — inspect these:")
            print(odd.reset_index()[["hotelId", "description", 2, 4, "ratio"]]
                  .drop_duplicates("description").head(12).to_string(index=False))

    # ----------------------------------------------------------- 2. VOCABULARY
    rule("2. VOCABULARY — every description string the supplier actually sends")
    s2 = d[d["nights"] == 2]
    for inc in (False, True):
        side = s2[s2["included"] == inc]
        label = "DUE AT PROPERTY (included=false)" if not inc else "ALREADY IN THE PRICE (included=true)"
        print(f"\n--- {label} — {len(side)} line items ---")
        vc = side["description"].replace("", "(empty string)").value_counts()
        for desc, n in vc.items():
            amts = side[side["description"].replace("", "(empty string)") == desc]["amount"]
            print(f"  {n:>5}x  {desc!r:<34} ${amts.min():>8.2f} - ${amts.max():>8.2f}"
                  f"   distinct={amts.nunique()}")

    rule("3. WHICH DESCRIPTIONS DOES OUR CURRENT LABEL MAP MISS?")
    # Mirrors describeFeeKind() in src/lib/liteapi.ts
    KNOWN = [("RESORT", "resort fee"), ("CLEAN", "cleaning fee"), ("SERVICE", "service fee"),
             ("CITY", "city tax"), ("OCCUPANC", "occupancy tax"), ("TAX", "tax")]
    unmatched = Counter()
    for desc, n in s2[~s2["included"]]["description"].value_counts().items():
        up = desc.upper()
        if not any(k in up for k, _ in KNOWN):
            unmatched[desc] = n
    if unmatched:
        print("These fall through to the generic 'hotel fee' today:")
        for desc, n in unmatched.most_common():
            print(f"  {n:>5}x  {desc!r}")
    else:
        print("none — every description hits a known label")

    # DANGER: anything we currently call a "tax" that may not be one.
    rule("4. MISLABEL RISK — charges our code would call 'tax'")
    risky = s2[(~s2["included"]) & s2["description"].str.upper().str.contains("TAX", na=False)]
    print(f"{len(risky)} line items would render as a tax. Amount spread per hotel:")
    if len(risky):
        g = risky.groupby("hotelId")["amount"].agg(["count", "min", "max", "nunique"])
        print(g.to_string())
        print("\nA government tax is a fixed percentage of the room rate, so within one")
        print("hotel+stay it should track the rate, not vary independently. Wide spread")
        print("at identical room prices means it is NOT purely a tax.")

    # --------------------------------------------------------- 5. CORROBORATION
    rule("5. CORROBORATION — does /data/hotel describe these charges in prose?")
    for hid in ids[:3]:
        try:
            det = (get("/data/hotel", {"hotelId": hid}) or {}).get("data") or {}
        except Exception as exc:  # noqa: BLE001
            print(f"  {hid}: detail fetch failed {exc}")
            continue
        hits = {k: v for k, v in det.items()
                if re.search(r"fee|polic|charge|tax|important|checkin", k, re.I)}
        print(f"\n  {hid} — {det.get('name', '?')}")
        for k, v in hits.items():
            txt = json.dumps(v)[:400] if not isinstance(v, str) else v[:400]
            print(f"    {k}: {txt}")

    d.to_csv(HERE / "fees-raw.csv", index=False)
    print(f"\nwrote analysis/fees-raw.csv ({len(d)} fee line items)")


if __name__ == "__main__":
    main()
