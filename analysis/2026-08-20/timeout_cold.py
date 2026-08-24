#!/usr/bin/env python
"""The honest timeout measurement: every call cold, plus the undocumented default.

timeout_sweep.py produced a flat 0.35s median at every timeout and identical
plan counts across repeats — because LiteAPI CACHES a rates response for
identical parameters. Repeat calls never reached a supplier at all, so that run
measured the cache, not the timeout.

Here every request uses a check-in date no other request in the run uses, so
every measurement is a genuine cold supplier fan-out. One arm omits `timeout`
entirely, which is the only way to see the default: the docs give an example of
6 and state no default.

What matters is not latency alone but latency AGAINST what gets lost. A short
timeout is only cheap if the cheapest quote still arrives.

    python analysis/2026-08-20/timeout_cold.py
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

# None = omit the parameter, which is how the default gets measured.
ARMS: list[int | None] = [None, 2, 3, 4, 5, 6, 8, 10, 15, 30]


def post(body: dict) -> tuple[dict, float]:
    req = urllib.request.Request(
        BASE + "/hotels/rates",
        data=json.dumps(body).encode(),
        headers={"X-API-Key": KEY, "Content-Type": "application/json"},
    )
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=300) as r:
        payload = json.loads(r.read().decode())
    return payload, time.perf_counter() - t0


def measure(resp: dict) -> tuple[int, int, float]:
    plans, rooms, cheapest = 0, set(), float("inf")
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
    p.add_argument("--repeats", type=int, default=3)
    p.add_argument("--cap", type=int, default=800)
    args = p.parse_args()

    ids = [x.strip() for x in args.hotels.split(",") if x.strip()]
    rows: dict[str, list[tuple[float, int, int, float]]] = defaultdict(list)

    # A distinct check-in per call defeats the response cache. Start far enough
    # out that availability is dense and the dates behave alike.
    start = date.today() + timedelta(days=29)
    slot = 0

    for rep in range(args.repeats):
        for arm in ARMS:
            ci = start + timedelta(days=slot)
            slot += 1
            body = {
                "hotelIds": ids,
                "occupancies": [{"adults": 2}],
                "currency": "USD",
                "guestNationality": "US",
                "checkin": ci.isoformat(),
                "checkout": (ci + timedelta(days=2)).isoformat(),
                "maxRatesPerHotel": args.cap,
                "margin": 0,
                "roomMapping": True,
            }
            if arm is not None:
                body["timeout"] = arm
            label = "default" if arm is None else str(arm)
            try:
                resp, secs = post(body)
            except urllib.error.HTTPError as e:
                print(f"  rep {rep} arm {label:>7}: HTTP {e.code}")
                continue
            plans, nrooms, cheapest = measure(resp)
            rows[label].append((secs, plans, nrooms, cheapest))
            print(f"  rep {rep}  arm {label:>7}  {ci}  {secs:5.2f}s  {plans:>4} plans  "
                  f"{nrooms:>3} rooms  cheapest {cheapest:8.2f}")

    print("\n" + "=" * 86)
    print(f"{'timeout':>9} {'median s':>9} {'min s':>7} {'max s':>7} {'plans':>7} "
          f"{'rooms':>7} {'cheapest (median)':>18}")
    print("=" * 86)
    for arm in ARMS:
        label = "default" if arm is None else str(arm)
        v = rows.get(label) or []
        if not v:
            continue
        secs = [x[0] for x in v]
        print(f"{label:>9} {statistics.median(secs):>9.2f} {min(secs):>7.2f} {max(secs):>7.2f} "
              f"{statistics.median(x[1] for x in v):>7.0f} "
              f"{statistics.median(x[2] for x in v):>7.0f} "
              f"{statistics.median(x[3] for x in v):>18.2f}")

    out = HERE / "timeout-cold.json"
    out.write_text(json.dumps(rows, indent=1), encoding="utf-8")
    print(f"\nraw -> {out.name}")
    print("\nNOTE: each arm ran against DIFFERENT dates, so cheapest prices are not")
    print("directly comparable between arms — latency is. Price comparability would")
    print("need the same date per arm, which the cache makes impossible.")


if __name__ == "__main__":
    main()
