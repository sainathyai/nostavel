# The premise: LiteAPI is a real-time supplier fan-out

Established 2026-08-19. Everything in this folder assumes it.

**One `hotelId` is not one inventory. It is a live query across many wholesalers,
each holding its own contract for the same physical rooms, each naming and
pricing them independently.** LiteAPI queries them at request time, waits
`timeout` seconds, and returns whatever came back.

That one sentence accounts for every anomaly measured this session.

## What it explains

| observation | explanation |
|---|---|
| A 200-room hotel returns 1,300+ "rate plans" | ~10 wholesalers x rate codes x occupancy variants, not 1,300 real products |
| 112 distinct room-name strings at one hotel, collapsing to ~60 groups; `standard room,2 queen beds` and `STANDARD, 2 QUEEN BEDS` as separate rows | each supplier sends its own text; LiteAPI does not normalise it |
| 10 distinct fee vocabularies on a single room (`TAX`, `TaxPercent`+`ExtraPersonCharge`, `TAXESANDFEES`, `Tax Recovery Charges & Service Fees`, …) | each supplier's own schema, passed through verbatim. `Tax Recovery Charges & Service Fees` is Expedia/EAN's standard wording |
| Same room, same board, same refundability, prices spread ~9% | different wholesale contracts |
| Repeated identical requests return 1175 / 1250 / 1176 / 1339 / 1324 / 1290 plans | different suppliers answered inside the window each time |
| Call 2 was a strict SUBSET of call 1 (857 of 897, zero new) | the catalogue is stable; retrieval is partial |
| `cap 5000` returned 1292 but `cap 10000` returned 1220 | both exceeded real inventory, so the cap stopped binding — that gap is fan-out variance, nothing to do with the cap |
| Some plans put tax inside the rate, others bill it at the property | supplier convention, not hotel policy |
| `supplier: "nuitee"`, `supplierId: 2`, and `sid: 2` inside every decoded `offerId` | LiteAPI deliberately does not expose which wholesaler quoted |

## Consequences for how we build

**`timeout` is a commercial lever, not a performance knob.** It is how long
LiteAPI waits for suppliers, not how long we wait for LiteAPI. Measured: at
`timeout: 12` the cheapest standard rate was $764.25 on 3/3 runs; at
`timeout: 30` it was $748.65 on 3/3 — and the longer setting returned *faster*
(3.4s vs 4.4-5.1s). Cutting the window early just discards whoever had not
answered, and the cheapest quote is as likely to be dropped as any other.

**The duplicates are the product, not noise.** They are competing quotes for
the same room. The entire value we add is picking the best one — which means
never discarding a supplier's row before comparing it.

**Room matching is a cross-supplier problem.** We are not tidying one vendor's
sloppy names; we are reconciling ten vendors' independent naming of the same
physical room. That is why regex on bed words failed (it merged
`2 ROOM SUITE-2 QUEEN BEDS` with `Two Queens Suite`) and why a matching service
is the right tool.

**Fee structure must be compared, never assumed.** Two suppliers quoting the
same room can differ on whether tax is inside the rate. Ranking on the quoted
rate picks the wrong one roughly 40% of the time; only rate + charges-collected-
at-property compares fairly.

**Nothing may be cached across calls as if stable.** A plan present now may be
absent in 30 seconds, not because it sold out but because its supplier was slow.
This is the sharpest risk to any design that makes one call to decide something
and a second call to act on it: the second call sees a different set. Any such
flow needs to re-verify against what the second call actually returned rather
than assume the first call's choice survived.

## Still unknown

- Whether the supplier set is stable across longer periods, or genuinely rotates.
- Whether `sessionId` (price consistency) pins the supplier set as well as the
  price — if it does, it is the answer to the two-call problem.
- What `lastUpdatedAt` does. It appears in the API's own validation error as a
  valid search anchor but is absent from the OpenAPI request schema.
