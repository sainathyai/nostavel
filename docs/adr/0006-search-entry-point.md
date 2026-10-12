# ADR 0006: What the search bar accepts - hotel names and neighbourhoods

- **Status:** accepted
- **Date:** 2026-10-11
- **Ticket:** [NOS-66](https://syrav.atlassian.net/browse/NOS-66)
- **Deciders:** owner; measured by probe before deciding
- **Evidence:** `analysis/2026-10-11/probe-search-entry.mts` (which entry point can express
  the query; arrives on `main` with PR #42, where it was committed) and
  `analysis/2026-10-11/probe-localities.mts` (the perimeters, in this change)

## Context

The first thing the owner did with the deployed environment was look for a hotel they had
stayed in: *Holiday Inn Express Waikiki, 2058 Kuhio Avenue, Honolulu*. They could not reach
it, and said so twice - the second time naming the requirement precisely: "The search bar
should work for either city locality or hotel name. Unfortunately Waikiki is not a name I can
search for."

Nothing was missing from the inventory. An area search around Honolulu returns the hotel as
`Holiday Inn Express Waikiki by IHG | 2058 Kuhio Avenue`, among 73 results. The entry point
simply could not express either thing the owner typed.

**Why, exactly.** The typeahead (`/api/cities`) is entirely local data, in three tiers:
curated `DESTINATIONS` (perimeter searches), then LiteAPI's own US city list
(`src/data/us-cities.json`, harvested from `/data/cities?countryCode=US`), then the
international tier. There is no hotel tier at all, and "Waikiki" is in none of the three.
Measured 2026-10-11 (`analysis/2026-10-11/probe-search-entry.mts`):

| What the owner typed | What happened |
|---|---|
| `honolulu` | works - curated perimeter, 9 km, returns the hotel among many |
| `waikiki` | no usable suggestion. The supplier does not know it either: `/data/hotels?cityName=Waikiki&countryCode=US` returns **0 results** |
| `holiday inn` | nothing. No code path anywhere looks up a hotel by name |

Checked against the harvested city list, the neighbourhood problem is much narrower than it
looks. Most famous lodging areas are already present as cities in the supplier's own
vocabulary: Hollywood CA, La Jolla, Lahaina, Wailea, Kihei, Pigeon Forge, Sunny Isles Beach,
Clearwater Beach, Lake Buena Vista. Exactly three candidates are broken, in two ways:

- **absent entirely:** Waikiki, French Quarter (also Poipu)
- **present, but wrong:** `South Beach` resolves to **South Beach, NY** - Staten Island, not
  Miami Beach. A name that resolves to the wrong coast is worse than one that does not
  resolve, because nothing looks like a failure.

## Options

Two separable problems, so two option sets.

### Finding a hotel by name

| Option | Cost | Risk | Notes |
|---|---|---|---|
| Keep it impossible | $0 | the owner's stated requirement goes unmet | Where we were |
| **`/data/hotels?hotelName=`** | no published price; on the search path already | a supplier call driven by typing | **Measured: works, and loosely.** `holiday inn express waik` (partial, lower case) returns the target with id and coordinates. `countryCode` is **required** - without it, HTTP 400, and the error names the alternatives: country code, lat/lng, placeId, lastUpdatedAt, IATA code, or hotelIds |
| `/data/places?type=hotel` | **$0.01 per request** | rate limited | See below |

### Finding a neighbourhood by name

| Option | Cost | Risk | Notes |
|---|---|---|---|
| Keep it impossible | $0 | requirement unmet | |
| **Curated `DESTINATIONS` entries with measured perimeters** | $0, local data | each entry is a claim about where a neighbourhood is, which can be wrong | Already the mechanism for 60-odd cities, towns and parks. Curated matches are prepended in `/api/cities`, so a curated entry also *outranks* a wrong one like South Beach NY |
| `/data/places?type=locality` | **$0.01 per request** | rate limited, and wrong here | See below |
| Harvest a neighbourhood dataset (GeoNames etc.) | a day's work | a new dataset to keep | Breadth we have no evidence anyone needs. Three names are broken, not three hundred |

### Why `/data/places` is rejected outright

It is the endpoint that looks purpose-built for this, and three measurements rule it out:

1. **Price.** $0.01 per request, against a total infrastructure budget of $2-5 a month
   (ADR 0005). A per-keystroke autocomplete at a cent a keystroke is not a feature, it is a
   bill.
2. **Reliability.** Two of three calls returned HTTP 429 `You have exceeded the allowed
   request limit` on the sandbox, in a probe making eight requests in total. The app's own
   client retries a 429 with backoff, so through the app this would not have surfaced as an
   error - it would have surfaced as a typeahead that sometimes takes seconds. That is why
   the hotel lookup below has a deadline as well as a gate.
3. **It does not answer the question.** For `textQuery=Waikiki` the first result is
   **Waikiki, Western Australia**; the rest are a Marriott in Honolulu and a retro hotel in
   Myrtle Beach. Honolulu's Waikiki is never offered. The one query that started this ticket
   is the one it gets wrong, and it charges a cent to do it.

## Decision

**Both tiers, neither of them through `/data/places`.**

### 1. Three curated localities, each with a perimeter measured first

A curated entry is `lat`, `lng` and a radius in metres - numbers that assert where a
neighbourhood is. `analysis/2026-10-11/probe-localities.mts` is the source for them: for each
candidate centre it asks the supplier which hotels fall inside and prints each one's street
address and distance from the centre, so the boundary is judged rather than asserted.

| Locality | Centre | Radius | What the measurement showed |
|---|---|---|---|
| Waikiki, HI | 21.2793, -157.8292 | 2200 m | 50 of 50 returned hotels are genuinely in Waikiki - Kalakaua, Kuhio, Lewers, Seaside - furthest 2038 m (the Diamond Head end, correct). **The owner's hotel is at 525 m** |
| French Quarter, LA | 29.9584, -90.0644 | 1500 m | Royal, Bourbon, Chartres, Canal. Bleeds one block into the CBD at the far edge, which is where the Quarter's own hotels are |
| South Beach, FL | 25.7823, -80.1322 | 2000 m | Collins, Ocean, Washington, 1st to 23rd. Nothing outside the radius |

`DestType` gains `"locality"`. Nothing reads `DestType` today, so this is label-only; it
exists so the next person can tell a neighbourhood from a city without reading coordinates.

**Waikiki is a subset of Honolulu, deliberately.** The existing Honolulu perimeter (9 km)
returns more than 200 hotels across the island's south shore. "Waikiki" meaning the 50-plus
hotels on the strip is the whole point of the entry: a guest who types it is excluding the
airport and downtown on purpose.

### 2. A hotel tier in the typeahead, gated so it rarely fires

Hotel suggestions come from `/data/hotels?hotelName=<q>&countryCode=US`, and picking one goes
**straight to that hotel's page** (`/stay/<id>`), carrying the dates already in the form. The
hotel page already supports arriving cold - it has a `defaultCheckin()` for exactly that - so
this adds no new route, no new `SearchTarget` kind and no new `dest` encoding. A guest who
names one hotel is not asking for a list.

The gate, because this is the first supplier call in this app driven by typing:

- **The query is at least 4 characters.**
- **No local tier matched it by exact, prefix or substring.** Deliberately *not* counting
  fuzzy matches: a fuzzy match is a guess, and a guess is not a reason to withhold a real
  hotel. If the query names a place, we show places and never ask the supplier.
- **Answers are cached in the serving process** for 10 minutes, keyed by the normalised
  query, so a guest deleting and retyping a character pays for one lookup.
- **A failed lookup is invisible.** Any error, including a 429, returns the local results
  alone. The typeahead must not break because a supplier is unhappy.

So `holiday inn` (no local match) asks the supplier; `waikiki` no longer does, because it now
matches a curated locality; `austin` never does.

**US only, for now.** `countryCode` is required and the typeahead has no country at the
moment someone is typing. The curated set is US-only, so this matches where the app already
works. Recorded as a known limit rather than hidden: searching a hotel by name outside the US
returns nothing, with no error.

## Consequences

- **Good:** the two things the owner asked for both work. The reported hotel is reachable
  three ways now: by the Honolulu perimeter, by the Waikiki perimeter, and by typing its name.
- **Good:** South Beach stops resolving to Staten Island.
- **Costs:** one supplier call per typed query that names no known place, bounded by the gate
  and the cache. `/data/hotels` has no published price; it is the same endpoint every search
  already calls, but this is the first time *typing* can trigger one, which is a new shape of
  spending even if it is a small one.
- **Costs:** three hand-maintained perimeters. They were measured once and nothing re-checks
  them; a supplier that moves a hotel's coordinates will not tell us.
- **Deliberately not solved:** neighbourhood coverage beyond the three measured names;
  hotel-name search outside the US; hotel names in the natural-language assistant path
  (`interpret-query.ts` resolves a `dest`, so it inherits the localities and not the hotel
  tier).
- **Follow-up:** count the hotel-name lookups the environment actually makes before adding
  any more entry points, and pass the selected destination's country once there is one.

## Revisit when

- The hotel-name lookup turns out to cost anything measurable, or starts returning 429s.
- A fourth broken locality appears. One is a data entry; a pattern of them means the harvested
  city list is the wrong source and a neighbourhood dataset is worth the work.
- Someone needs a hotel by name outside the US.
