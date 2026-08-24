#!/usr/bin/env python
"""Pull rates with roomMapping enabled and measure how far mappedRoomId compresses.

LiteAPI support's recommended approach: set `roomMapping: true`, group by
`mappedRoomId` rather than by room name, then dedupe the commercial variants
inside each room with a "rate signature" of the attributes that actually differ
for a guest.

This script does the pull and answers one question first: does mappedRoomId
exist in the response, and how many distinct values are there versus the raw
plan count. Everything else depends on that.

Uses timeout 30 — measured 2026-08-19, a shorter supplier window drops the
cheapest quotes and is not faster. See premise.md.

    python analysis/2026-08-19/pull_mapped.py
    python analysis/2026-08-19/pull_mapped.py --ids lp1b919 --cap 6000
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).resolve().parent
RAW = HERE / "raw"
BASE = "https://api.liteapi.travel/v3.0"

# Known-messy hotels from earlier work: Hilton NOLA holds 6,000+ plans, the
# two Asheville properties ~1,300 each.
DEFAULT_IDS = ["lp1b919", "lp225d01", "lp40992"]


def api_key() -> str:
    for line in (HERE.parent.parent / ".env.local").read_text(encoding="utf-8").splitlines():
        if line.startswith("LITEAPI_KEY"):
            return line.partition("=")[2].strip().strip("\"'")
    raise SystemExit("LITEAPI_KEY not found in .env.local")


KEY = api_key()


def post(path: str, body: dict) -> dict:
    req = urllib.request.Request(
        BASE + path, data=json.dumps(body).encode(),
        headers={"X-API-Key": KEY, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read().decode())


def walk(entry: dict):
    """Yield (roomType, rate) for every plan, with package rates kept.

    Nothing is filtered here: this pass is about measuring the shape of what
    LiteAPI returns, so a filter applied now would bias the answer.
    """
    for rt in entry.get("roomTypes") or []:
        for rate in rt.get("rates") or []:
            yield rt, rate


def find_mapped(rt: dict, rate: dict):
    """mappedRoomId is undocumented as to placement — look in both levels."""
    for src in (rate, rt):
        for k in ("mappedRoomId", "mappedRoomID", "mapped_room_id"):
            if src.get(k) is not None:
                return k, src[k]
    return None, None


def rule(t: str) -> None:
    print(f"\n{'=' * 82}\n{t}\n{'=' * 82}")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--ids", default=",".join(DEFAULT_IDS))
    p.add_argument("--checkin", default="2026-10-13")
    p.add_argument("--checkout", default="2026-10-15")
    p.add_argument("--cap", type=int, default=5000)
    p.add_argument("--timeout", type=int, default=30)
    args = p.parse_args()

    RAW.mkdir(parents=True, exist_ok=True)
    ids = [x.strip() for x in args.ids.split(",") if x.strip()]

    for hid in ids:
        body = {
            "hotelIds": [hid],
            "occupancies": [{"adults": 2}],
            "currency": "USD",
            "guestNationality": "US",
            "checkin": args.checkin,
            "checkout": args.checkout,
            "maxRatesPerHotel": args.cap,
            "timeout": args.timeout,
            "margin": 0,          # only margin 0 shows true net and a real SSP
            "roomMapping": True,  # the thing under test
        }
        try:
            resp = post("/hotels/rates", body)
        except urllib.error.HTTPError as e:
            print(f"{hid}: HTTP {e.code} {e.read().decode()[:120]}")
            continue

        out = RAW / f"{hid}-mapped.json"
        out.write_text(json.dumps({"request": body, "response": resp}, indent=2),
                       encoding="utf-8")

        data = resp.get("data") or []
        if not data:
            print(f"{hid}: no data")
            continue
        entry = data[0]
        plans = list(walk(entry))

        rule(f"{hid} — {len(plans)} plans   ({out.name}, {out.stat().st_size/1024/1024:.1f} MB)")

        # --- does mappedRoomId exist at all? ---
        keys_seen = Counter()
        mapped = []
        for rt, rate in plans:
            k, v = find_mapped(rt, rate)
            keys_seen[k or "(absent)"] += 1
            mapped.append(v)

        print("mappedRoomId present:", dict(keys_seen))
        if all(m is None for m in mapped):
            print("\n  NOT RETURNED. roomMapping:true was sent and accepted, but no")
            print("  mapped id appears on either roomTypes[] or rates[]. Falling back")
            print("  to the ids that do exist:")
            print(f"    distinct roomTypeId : {len({rt.get('roomTypeId') for rt, _ in plans})}")
            print(f"    distinct rate name  : {len({r.get('name') for _, r in plans})}")
            continue

        distinct = {m for m in mapped if m is not None}
        print(f"\n  raw plans              {len(plans):>6}")
        print(f"  distinct mappedRoomId  {len(distinct):>6}"
              f"   -> {len(plans)/max(len(distinct),1):.0f}x compression")
        print(f"  distinct roomTypeId    {len({rt.get('roomTypeId') for rt, _ in plans}):>6}")
        print(f"  distinct rate name     {len({r.get('name') for _, r in plans}):>6}")
        print(f"  plans with NO mapping  {sum(1 for m in mapped if m is None):>6}")

        # --- how many names collapse into each mapped room? ---
        names_per = defaultdict(set)
        for (rt, rate), m in zip(plans, mapped):
            if m is not None:
                names_per[m].add(rate.get("name") or "")
        multi = {k: v for k, v in names_per.items() if len(v) > 1}
        print(f"\n  mapped rooms gathering >1 supplier name: {len(multi)} of {len(names_per)}")
        for m, names in sorted(multi.items(), key=lambda x: -len(x[1]))[:4]:
            print(f"    {m}  ({len(names)} names)")
            for n in sorted(names)[:6]:
                print(f"        {n[:68]}")

        # --- the signature LiteAPI suggested, applied inside each mapped room ---
        def signature(rate):
            cp = rate.get("cancellationPolicies") or {}
            infos = tuple(sorted((i.get("cancelTime"), i.get("amount"))
                                 for i in (cp.get("cancelPolicyInfos") or [])))
            rr = rate.get("retailRate") or {}
            total = ((rr.get("total") or [{}])[0]).get("amount")
            return (rate.get("boardType"), cp.get("refundableTag"),
                    tuple(rate.get("paymentTypes") or []), infos, total)

        sigs = {(m, signature(r)) for (rt, r), m in zip(plans, mapped) if m is not None}
        # A looser bucket: what a guest actually chooses between.
        buckets = {(m, r.get("boardType"),
                    (r.get("cancellationPolicies") or {}).get("refundableTag"))
                   for (rt, r), m in zip(plans, mapped) if m is not None}
        print(f"\n  mappedRoomId x full rate signature : {len(sigs):>5}")
        print(f"  mappedRoomId x board x refundable  : {len(buckets):>5}"
              f"   <- bookable choices a guest sees")


if __name__ == "__main__":
    main()
