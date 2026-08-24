#!/usr/bin/env python
"""The full booking chain, end to end, against the LiteAPI sandbox.

This chain has never been run start to finish. It exercises exactly the calls
src/lib/liteapi.ts makes, in the same order and with the same parameters, so a
failure here is a failure the app would have.

    1. POST /hotels/rates          margin 0   — the baseline, for SSP evidence
    2. POST /hotels/rates          margin N   — the priced, bookable offers
    3. POST /rates/prebook                    — hold + card session
    4. POST /rates/book                       — finalize (TRANSACTION_ID only)
    5. GET  /bookings/{id}                    — read it back
    6. (optional) cancel, so the sandbox is left clean

Step 4 is the one that has never been proven. `usePaymentSdk: true` is the only
payment route this codebase permits: LiteAPI is merchant of record, the guest's
card is charged by them, and we are paid commission. The alternative
(ACC_CREDIT_CARD / WALLET) would bill OUR account and hand us the fraud and
chargeback liability, and must never appear here.

    python analysis/2026-08-20/e2e_booking.py            # stops before booking
    python analysis/2026-08-20/e2e_booking.py --book     # actually books
    python analysis/2026-08-20/e2e_booking.py --book --cancel
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

MARGIN = 12  # BASE_MARGIN_PCT from src/lib/pricing.ts


def call(method: str, path: str, body: dict | None = None):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"X-API-Key": KEY, "Content-Type": "application/json"},
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return json.loads(r.read().decode()), None
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}: {e.read().decode()[:300]}"


def step(n: int, what: str) -> None:
    print(f"\n{'-' * 78}\n{n}. {what}\n{'-' * 78}")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--hotel", default="lp85c07")
    p.add_argument("--book", action="store_true", help="actually POST /rates/book")
    p.add_argument("--cancel", action="store_true", help="cancel afterwards")
    args = p.parse_args()

    ci = date.today() + timedelta(days=45)
    co = ci + timedelta(days=2)
    common = {
        "hotelIds": [args.hotel],
        "occupancies": [{"adults": 2}],
        "currency": "USD",
        "guestNationality": "US",
        "checkin": ci.isoformat(),
        "checkout": co.isoformat(),
        "maxRatesPerHotel": 800,
        "roomMapping": True,
        "timeout": 5,
    }
    print(f"hotel {args.hotel}   {ci} -> {co}   2 adults   margin {MARGIN}%")

    step(1, "BASELINE rates (margin 0) — SSP evidence, never bookable")
    base, err = call("POST", "/hotels/rates", {**common, "margin": 0})
    if err:
        print("  FAIL", err)
        return
    sourced = 0
    plans = 0
    for e in base.get("data") or []:
        for rt in e.get("roomTypes") or []:
            for ra in rt.get("rates") or []:
                plans += 1
                ssp = ((ra.get("retailRate") or {}).get("suggestedSellingPrice") or [{}])[0]
                if (ssp.get("source") or "").strip():
                    sourced += 1
    print(f"  PASS  {plans} plans, {sourced} carrying a sourced SSP")

    step(2, "PRICED rates (margin %d) — the offers a guest can book" % MARGIN)
    priced, err = call("POST", "/hotels/rates", {**common, "margin": MARGIN})
    if err:
        print("  FAIL", err)
        return
    offers = []
    for e in priced.get("data") or []:
        for rt in e.get("roomTypes") or []:
            if rt.get("rateType") == "package":
                continue
            ra = (rt.get("rates") or [{}])[0]
            amt = (rt.get("offerRetailRate") or {}).get("amount")
            if rt.get("offerId") and amt is not None:
                offers.append((amt, rt["offerId"], ra.get("name"),
                               (ra.get("commission") or [{}])[0].get("amount")))
    if not offers:
        print("  FAIL  no bookable offers")
        return
    offers.sort()
    amt, offer_id, room, commission = offers[0]
    print(f"  PASS  {len(offers)} offers; cheapest {amt:.2f} ({room})")
    print(f"        our commission on it: {commission}")

    step(3, "PREBOOK — hold the rate and open a guest card session")
    pb, err = call("POST", "/rates/prebook", {"offerId": offer_id, "usePaymentSdk": True})
    if err:
        print("  FAIL", err)
        return
    d = pb.get("data") or {}
    prebook_id = d.get("prebookId")
    txn = d.get("transactionId")
    secret = d.get("secretKey")
    print(f"  PASS  prebookId {prebook_id}")
    print(f"        price {d.get('price')}  commission {d.get('commission')}  "
          f"priceDifferencePercent {d.get('priceDifferencePercent')}")
    print(f"        transactionId {'PRESENT' if txn else 'MISSING'}   "
          f"secretKey {'PRESENT' if secret else 'MISSING'}")
    if not txn or not secret:
        # booking-service.ts fails the booking here for exactly this reason.
        print("        -> the app would mark this booking failed and stop, by design")
        return

    if not args.book:
        print("\nStopping before /rates/book. Re-run with --book to finalize.")
        print("NOTE: the guest's card is charged through Stripe in the BROWSER using")
        print("      the secretKey above. Booking without that payment step tests the")
        print("      API contract, not a real paid stay.")
        return

    step(4, "BOOK — finalize against the guest payment (TRANSACTION_ID only)")
    booked, err = call("POST", "/rates/book", {
        "prebookId": prebook_id,
        "holder": {"firstName": "Test", "lastName": "Guest", "email": "sandbox@nostavel.com"},
        "guests": [{
            "occupancyNumber": 1,
            "firstName": "Test",
            "lastName": "Guest",
            "email": "sandbox@nostavel.com",
        }],
        "payment": {"method": "TRANSACTION_ID", "transactionId": txn},
    })
    if err:
        print("  FAIL", err)
        return
    b = booked.get("data") or {}
    booking_id = b.get("bookingId")
    print(f"  PASS  bookingId {booking_id}  status {b.get('status')}")
    print(f"        supplierBookingId {b.get('supplierBookingId')}  "
          f"confirmation {b.get('hotelConfirmationCode')}")

    step(5, "READ BACK — GET /bookings/{id}")
    got, err = call("GET", f"/bookings/{booking_id}")
    if err:
        print("  FAIL", err)
    else:
        g = got.get("data") or {}
        print(f"  PASS  status {g.get('status')}  checkin {g.get('checkin')}  "
              f"hotel {(g.get('hotel') or {}).get('name')}")

    if args.cancel and booking_id:
        step(6, "CANCEL — leave the sandbox clean")
        _, err = call("PUT", f"/bookings/{booking_id}")
        print("  " + ("FAIL " + err if err else "PASS  cancelled"))

    out = HERE / "e2e-booking.json"
    out.write_text(json.dumps({"prebook": d, "book": b}, indent=1), encoding="utf-8")
    print(f"\nraw -> {out.name}")


if __name__ == "__main__":
    main()
