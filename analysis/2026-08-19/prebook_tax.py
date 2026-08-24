#!/usr/bin/env python
"""Who collects the EXCLUDED taxes and fees — LiteAPI at checkout, or the hotel?

The detail page currently prints "+ $72 taxes due at the property" for every
`taxesAndFees` line with `included: false`. That claim is ours, not LiteAPI's:
the field only says the amount is not inside `retailRate.total`. It says nothing
about who collects it.

It matters because the excluded set is NOT only resort fees. Measured across 3
hotels: `TAX` (34x), `government tax` (27x), `Mandatory Tax`, `Tax per Night`
all come back excluded. Telling a guest a government tax is payable at the
property, when in fact we charge it at checkout, misstates the price twice.

The test is unambiguous: take an offer whose excluded lines are taxes, prebook
it, and compare the prebook price to `retailRate.total`.

    total          -> LiteAPI charges the rate only; the rest is at the hotel
    total + excl   -> LiteAPI collects it at checkout; "due at property" is wrong

    python analysis/2026-08-19/prebook_tax.py

Prebook is a hold, not a booking, and this is the sandbox key.
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
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

TAXY = ("tax", "government", "vat", "occupanc", "lodging")


def post(path: str, body: dict) -> dict:
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode(),
        headers={"X-API-Key": KEY, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read().decode())


def main() -> None:
    hotels = ["lp225d01", "lp40992", "lp1b919"]
    resp = post(
        "/hotels/rates",
        {
            "hotelIds": hotels,
            "occupancies": [{"adults": 2}],
            "currency": "USD",
            "guestNationality": "US",
            "checkin": "2026-10-13",
            "checkout": "2026-10-15",
            "maxRatesPerHotel": 200,
            "timeout": 30,
            "margin": 0,
            "roomMapping": True,
        },
    )

    # One case per distinct excluded-line vocabulary, so the answer isn't drawn
    # from a single supplier's habits.
    cases: dict[str, dict] = {}
    for entry in resp.get("data") or []:
        for rt in entry.get("roomTypes") or []:
            for rate in rt.get("rates") or []:
                rr = rate.get("retailRate") or {}
                excl = [f for f in (rr.get("taxesAndFees") or []) if not f.get("included")]
                if not excl:
                    continue
                vocab = " + ".join(sorted((f.get("description") or "?") for f in excl))
                cases.setdefault(
                    vocab,
                    {
                        "hotel": entry.get("hotelId"),
                        "room": rate.get("name"),
                        "offerId": rt.get("offerId"),
                        "total": (rr.get("total") or [{}])[0].get("amount"),
                        "excl": [(f.get("description"), f.get("amount")) for f in excl],
                    },
                )

    print(f"{len(cases)} distinct excluded-line vocabularies to test\n")
    for vocab, c in cases.items():
        excl_sum = round(sum(a for _, a in c["excl"]), 2)
        taxy = [d for d, _ in c["excl"] if any(t in (d or "").lower() for t in TAXY)]
        try:
            pb = post("/rates/prebook", {"offerId": c["offerId"], "usePaymentSdk": True})
        except urllib.error.HTTPError as e:
            print(f"{vocab:<48} prebook HTTP {e.code}: {e.read().decode()[:100]}")
            continue
        d = pb.get("data") or {}
        price = d.get("price")
        charged_here = abs((price or 0) - (c["total"] + excl_sum)) < 0.02
        rate_only = abs((price or 0) - c["total"]) < 0.02
        verdict = (
            "COLLECTED AT CHECKOUT" if charged_here else "left to the hotel" if rate_only else "?"
        )
        print(f"{vocab}")
        print(f"  {c['hotel']}  {str(c['room'])[:46]}")
        print(f"  rates.total   {c['total']:>9.2f}")
        print(f"  excluded      {excl_sum:>9.2f}   {c['excl']}")
        print(f"  prebook.price {price if price is None else f'{price:>9.2f}'}   -> {verdict}")
        if taxy:
            print(f"  tax-worded lines here: {taxy}")
        # The prebook payload is the contractual statement of what the guest
        # pays; dump anything that names the rest so we quote LiteAPI, not us.
        for k in ("priceType", "commission", "priceDifferencePercent", "cancellationChanged"):
            if k in d:
                print(f"  {k}: {d[k]}")
        for k in ("taxesAndFees", "roomTypes", "hotel"):
            if k in d and k != "roomTypes":
                print(f"  {k}: {json.dumps(d[k])[:200]}")
        print()

    out = HERE / "raw" / "prebook-tax.json"
    out.write_text(json.dumps(cases, indent=2), encoding="utf-8")
    print(f"cases written to {out.name}")


if __name__ == "__main__":
    main()
