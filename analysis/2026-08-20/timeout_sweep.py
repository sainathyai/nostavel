#!/usr/bin/env python
"""What is `timeout` actually buying us?

`timeout` is how long LiteAPI waits for its SUPPLIERS before answering with
whoever replied. So it trades page latency against inventory and price: too
short and the cheapest wholesaler is cut off mid-answer, too long and the guest
waits for suppliers that add nothing.

An earlier two-point check (12 vs 30) suggested longer was both cheaper AND
faster, which is not a shape a timeout can really have — it looked like
supplier-side variance, not a trend. This sweeps the whole range with repeats so
the noise is visible instead of being mistaken for signal.

Measured per (timeout, repeat): wall time, plans returned, mapped rooms, and the
cheapest all-in price. The last is what matters commercially — a faster call
that loses the cheapest quote is not faster, it is worse.

    python analysis/2026-08-20/timeout_sweep.py
    python analysis/2026-08-20/timeout_sweep.py --repeats 5 --hotels lp85c07
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
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

TIMEOUTS = [2, 4, 6, 8, 10, 15, 20, 30]


def post(path: str, body: dict) -> tuple[dict, float]:
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode(),
        headers={"X-API-Key": KEY, "Content-Type": "application/json"},
    )
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=300) as r:
        payload = json.loads(r.read().decode())
    return payload, time.perf_counter() - t0


def measure(resp: dict) -> tuple[int, int, float]:
    plans = 0
    rooms = set()
    cheapest = float("inf")
    for entry in resp.get("data") or []:
        for rt in entry.get("roomTypes") or []:
            if rt.get("rateType") == "package":
                continue
            for ra in rt.get("rates") or []:
                plans += 1
                rooms.add(ra.get("mappedRoomId"))
                rr = ra.get("retailRate") or {}
                total = ((rr.get("total") or [{}])[0]).get("amount")
                exc = sum(
                    f.get("amount") or 0
                    for f in (rr.get("taxesAndFees") or [])
                    if not f.get("included")
                )
                if total is not None:
                    cheapest = min(cheapest, total + exc)
    return plans, len(rooms), cheapest


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--hotels", default="lp85c07,lp1b919,lp225d01,lp40992")
    p.add_argument("--checkin", default="2026-09-18")
    p.add_argument("--checkout", default="2026-09-20")
    p.add_argument("--repeats", type=int, default=3)
    p.add_argument("--cap", type=int, default=800)
    args = p.parse_args()

    ids = [x.strip() for x in args.hotels.split(",") if x.strip()]
    rows: dict[int, list[tuple[float, int, int, float]]] = defaultdict(list)

    # Interleave the repeats rather than looping each timeout to completion:
    # supplier availability drifts over minutes, and a block design would hand
    # that drift to whichever timeout happened to run during a good patch.
    for rep in range(args.repeats):
        for t in TIMEOUTS:
            body = {
                "hotelIds": ids,
                "occupancies": [{"adults": 2}],
                "currency": "USD",
                "guestNationality": "US",
                "checkin": args.checkin,
                "checkout": args.checkout,
                "maxRatesPerHotel": args.cap,
                "margin": 0,
                "roomMapping": True,
                "timeout": t,
            }
            try:
                resp, secs = post("/hotels/rates", body)
            except urllib.error.HTTPError as e:
                print(f"  timeout {t:>2} rep {rep}: HTTP {e.code}")
                continue
            plans, rooms, cheapest = measure(resp)
            rows[t].append((secs, plans, rooms, cheapest))
            print(f"  rep {rep}  timeout {t:>2}  {secs:5.2f}s  {plans:>4} plans  "
                  f"{rooms:>3} rooms  cheapest {cheapest:8.2f}")

    print("\n" + "=" * 78)
    print(f"{'timeout':>8} {'median s':>9} {'max s':>7} {'plans':>7} {'rooms':>7} "
          f"{'cheapest':>10} {'vs best':>8}")
    print("=" * 78)
    best = min(
        (min(c for _, _, _, c in v) for v in rows.values() if v),
        default=float("inf"),
    )
    for t in TIMEOUTS:
        v = rows.get(t) or []
        if not v:
            continue
        secs = [x[0] for x in v]
        cheap = min(x[3] for x in v)
        print(f"{t:>8} {statistics.median(secs):>9.2f} {max(secs):>7.2f} "
              f"{statistics.median(x[1] for x in v):>7.0f} "
              f"{statistics.median(x[2] for x in v):>7.0f} "
              f"{cheap:>10.2f} {cheap - best:>+8.2f}")

    out = HERE / "timeout-sweep.json"
    out.write_text(json.dumps({str(k): v for k, v in rows.items()}, indent=1), encoding="utf-8")
    print(f"\nraw -> {out.name}")


if __name__ == "__main__":
    main()
