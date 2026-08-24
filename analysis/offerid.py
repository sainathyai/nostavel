#!/usr/bin/env python
"""Decode LiteAPI's offerId to recover the real supplier identity.

Every rate reports `supplier: "nuitee"` and `supplierId: 2`, which tells us
nothing — that is LiteAPI itself. But offerId is base64(msgpack), and the
msgpack carries the upstream keys: `sid` (supplier id), `shid` (supplier's own
hotel id), `srid` (supplier rate id), `ssp` (which public source the SSP came
from), `nk` (network key).

Minimal msgpack reader rather than a dependency: the payload only uses maps,
arrays, strings, ints, floats and bools.

    python analysis/offerid.py
"""

from __future__ import annotations

import base64
import json
import struct
import sys
from collections import Counter, defaultdict
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).parent


class MP:
    """Just enough msgpack to read an offerId."""

    def __init__(self, b: bytes):
        self.b, self.i = b, 0

    def u8(self):
        v = self.b[self.i]; self.i += 1; return v

    def take(self, n):
        v = self.b[self.i:self.i + n]; self.i += n; return v

    def read(self):
        c = self.u8()
        if c <= 0x7F: return c                      # positive fixint
        if c >= 0xE0: return c - 256                # negative fixint
        if 0x80 <= c <= 0x8F: return self.map(c & 0x0F)
        if 0x90 <= c <= 0x9F: return self.arr(c & 0x0F)
        if 0xA0 <= c <= 0xBF: return self.str(c & 0x1F)
        if c == 0xC0: return None
        if c == 0xC2: return False
        if c == 0xC3: return True
        if c == 0xC4: return self.take(self.u8())                       # bin8
        if c == 0xC5: return self.take(struct.unpack(">H", self.take(2))[0])
        if c == 0xC6: return self.take(struct.unpack(">I", self.take(4))[0])
        if c == 0xCA: return struct.unpack(">f", self.take(4))[0]
        if c == 0xCB: return struct.unpack(">d", self.take(8))[0]
        if c == 0xCC: return self.u8()
        if c == 0xCD: return struct.unpack(">H", self.take(2))[0]
        if c == 0xCE: return struct.unpack(">I", self.take(4))[0]
        if c == 0xCF: return struct.unpack(">Q", self.take(8))[0]
        if c == 0xD0: return struct.unpack(">b", self.take(1))[0]
        if c == 0xD1: return struct.unpack(">h", self.take(2))[0]
        if c == 0xD2: return struct.unpack(">i", self.take(4))[0]
        if c == 0xD3: return struct.unpack(">q", self.take(8))[0]
        if c == 0xD9: return self.str(self.u8())
        if c == 0xDA: return self.str(struct.unpack(">H", self.take(2))[0])
        if c == 0xDB: return self.str(struct.unpack(">I", self.take(4))[0])
        if c == 0xDC: return self.arr(struct.unpack(">H", self.take(2))[0])
        if c == 0xDD: return self.arr(struct.unpack(">I", self.take(4))[0])
        if c == 0xDE: return self.map(struct.unpack(">H", self.take(2))[0])
        if c == 0xDF: return self.map(struct.unpack(">I", self.take(4))[0])
        raise ValueError(f"unhandled msgpack byte 0x{c:02x} at {self.i-1}")

    def str(self, n): return self.take(n).decode("utf-8", "replace")
    def arr(self, n): return [self.read() for _ in range(n)]
    def map(self, n): return {self.read(): self.read() for _ in range(n)}


def decode(offer_id: str):
    raw = base64.b64decode(offer_id + "=" * (-len(offer_id) % 4))
    return MP(raw).read()


def flatten(o, out=None, path=""):
    """Collect scalar leaves keyed by their dotted path."""
    out = {} if out is None else out
    if isinstance(o, dict):
        for k, v in o.items():
            flatten(v, out, f"{path}.{k}" if path else str(k))
    elif isinstance(o, list):
        for i, v in enumerate(o):
            flatten(v, out, f"{path}[{i}]")
    else:
        out[path] = o
    return out


def main():
    src = HERE / "raw" / "asheville-lp225d01-full.json"
    if not src.exists():
        raise SystemExit(f"missing {src}; run the export first")
    data = json.loads(src.read_text(encoding="utf-8"))["response"]["data"]

    decoded = []
    for rt in data[0].get("roomTypes") or []:
        oid = rt.get("offerId")
        if not oid:
            continue
        try:
            decoded.append((rt, flatten(decode(oid))))
        except Exception:
            continue
    print(f"decoded {len(decoded)} of {len(data[0].get('roomTypes') or [])} offerIds\n")

    print("=" * 84)
    print("FIELDS PRESENT (leaf paths, with how many distinct values each takes)")
    print("=" * 84)
    counts = defaultdict(set)
    for _, f in decoded:
        for k, v in f.items():
            if isinstance(v, (str, int, float, bool)) or v is None:
                counts[k].add(v if not isinstance(v, bytes) else "<bin>")
    interesting = []
    for k, vs in sorted(counts.items(), key=lambda x: len(x[1])):
        # Skip per-rate noise like prices and long opaque ids.
        sample = list(vs)[:4]
        short = all(len(str(s)) < 40 for s in sample)
        if short and len(vs) <= 40:
            interesting.append((k, vs))
    for k, vs in interesting:
        s = sorted((str(x) for x in vs))[:8]
        print(f"  {k:<22} {len(vs):>4} distinct   {', '.join(s)[:96]}")

    print()
    print("=" * 84)
    print("SUPPLIER KEYS — the fields that identify who is actually selling")
    print("=" * 84)
    for key in ["sid", "shid", "ssp", "nk", "rt", "brd", "isb", "ifm", "ifr", "ifchr", "seaid"]:
        vals = Counter()
        for _, f in decoded:
            for k, v in f.items():
                if k.split(".")[-1] == key and not isinstance(v, (dict, list, bytes)):
                    vals[v] += 1
        if vals:
            top = ", ".join(f"{k}({n})" for k, n in vals.most_common(8))
            print(f"  {key:<8} {len(vals):>3} distinct  {top[:100]}")

    print()
    print("=" * 84)
    print("DOES sid EXPLAIN THE FEE-VOCABULARY GROUPS?")
    print("=" * 84)
    pair = Counter()
    for rt, f in decoded:
        sid = next((v for k, v in f.items() if k.split(".")[-1] == "sid"), None)
        shid = next((v for k, v in f.items() if k.split(".")[-1] == "shid"), None)
        rate = (rt.get("rates") or [{}])[0]
        tf = (rate.get("retailRate") or {}).get("taxesAndFees") or []
        vocab = " + ".join(sorted((x.get("description") or "?") for x in tf)) or "(none)"
        pair[(sid, shid, vocab)] += 1
    print(f"{'sid':>5} {'shid':>12}  {'n':>5}  fee vocabulary")
    for (sid, shid, vocab), n in pair.most_common(24):
        print(f"{str(sid):>5} {str(shid):>12}  {n:>5}  {vocab[:56]}")


if __name__ == "__main__":
    main()
