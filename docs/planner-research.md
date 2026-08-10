# Itinerary Engine: Research Notes and Revised Plan

Research pass over the "deterministic algorithm before LLM" draft, checked against current (Aug 2026) data sources, licences, and tooling. Written against Nostavel's actual stack: Next.js on Cloud Run, Neon Postgres, MapLibre + Protomaps, LiteAPI hotels with lat/lng already on the client.

## Verdict

The core thesis is right and worth keeping: **compute the schedule with math, narrate it with an LLM.** An LLM asked to reason about drive times and closing hours will produce itineraries that cannot be executed, and you cannot debug a hallucinated timetable.

Three things in the draft do not survive contact with the real data:

1. **There are no opening hours in any of the recommended datasets.** The whole time-windows premise has nothing to populate it.
2. **The problem is not TSPTW.** It is orienteering. Building TSPTW literally produces a solver that reports infeasible on almost every real input.
3. **There is no POI quality signal either.** Nothing in Overture or Foursquare OS tells you a place is worth visiting, so the optimizer will confidently route a family to a tire shop.

Phases 1 through 3 as drafted build the parts that are already solved (spatial queries, routing matrices, VRP solvers are all commodity). The parts that decide whether the product is good, dwell times and POI scoring, are not in the plan at all.

---

## Finding 1: No opening hours anywhere in the free stack

**Overture places has no hours field.** Verified against the schema reference: `websites`, `socials`, `emails`, `phones`, `addresses[]`, `brand`, `confidence`, and a new `operating_status` (open / temporarily closed / permanently closed). There is no operating-hours property and no time-based status.

**Foursquare Open Source Places has no hours either.** The free OS tier is 22 core attributes: `fsq_place_id`, `name`, `latitude`, `longitude`, address parts, `date_created` / `date_refreshed` / `date_closed`, `tel`, `website`, socials, `fsq_category_ids`, `geom`, `bbox`. Hours, popularity, and ratings are Pro/Premium only. Marketing pages for Foursquare's paid Places product advertise "50+ attributes including hours and popularity," which is easy to misread as applying to the open dataset. It does not.

So the `time_windows` input to the solver has no source. This is the single biggest hole in the draft.

### What to do instead: tier the hours data

**Tier 1, authoritative first-party APIs for the categories you actually feature.** The [NPS API](https://www.nps.gov/subjects/developer/api-documentation.htm) is free with a self-serve key and returns real operating hours for parks, visitor centers, and campgrounds, plus entrance fees and alerts. Given your seasonal themes already include `national-parks`, `fall-foliage`, and `thanksgiving-smokies`, this covers a large slice of your catalogue with data you can actually trust. Do this one first.

**Tier 2, category default priors that you author.** A table mapping category to a typical open window and a typical dwell time. Museums 10:00 to 17:00 / 2h. Trailheads dawn to dusk / 3h. Sit-down dinner 17:00 to 22:00 / 90m. This is unglamorous and it is most of the value. It is also the input that dominates the schedule more than drive times do, which the draft under-weights.

**Tier 3, OSM `opening_hours` where present.** Machine-readable and free, but coverage is patchy and the values often lag what the business actually posts. Treat as a hint that overrides the category prior, never as ground truth.

**Then be honest in the UI.** Anything not from Tier 1 gets a "hours not verified, confirm before you go" affordance. That single line of copy is what stops the failure mode of a family driving 90 minutes to a closed museum, and it costs nothing.

### Do not reach for Google Places

Google Places has excellent hours, ratings, and popularity, and it is architecturally closed to you:

> "Customers must not use Google Maps Content from the Places API in conjunction with a non-Google map."

You have locked MapLibre + Protomaps. Showing Places-derived hours or ratings alongside your map is a terms violation. Separately, lat/lng from Places may only be cached for 30 consecutive days, which is incompatible with owning a POI database at all. There is a narrow carve-out (Places content is allowed in an app *without* a corresponding Google map), but a map-based trip planner is exactly the case it does not cover.

If you ever decide the hours problem is worth paying for, the options that do not conflict with MapLibre are Foursquare Places Pro/Premium or a per-vertical API like NPS. Not Google.

---

## Finding 2: The problem is TOPTW, not TSPTW

TSPTW requires visiting **every** node. An itinerary selects a subset: you have 50 candidate POIs near the hotel and a 9-hour day that fits four of them. Feed 50 mandatory nodes into a day-length constraint and OR-Tools correctly reports infeasible, every time.

The correct model is the **Orienteering Problem with Time Windows**, and for multi-day, the **Team Orienteering Problem with Time Windows (TOPTW)**, where "team" means one vehicle per day. This is the standard formulation for what the literature calls the Tourist Trip Design Problem: select a subset of scored POIs to maximise total score subject to a time budget and per-POI time windows. It is NP-hard; the workhorse heuristic is iterated local search, and OR-Tools' routing solver handles it fine at your scale.

In OR-Tools the mechanic is one line per POI:

```python
for node in poi_nodes:
    routing.AddDisjunction([manager.NodeToIndex(node)], penalty=score[node])
```

The disjunction makes the visit optional; skipping it costs `penalty`. Set the penalty proportional to how much you want that POI in the trip and minimising cost becomes maximising collected score. Hotel start/end nodes get no disjunction, so they stay mandatory.

Two consequences worth internalising:

- **Every POI needs a score.** The disjunction penalty *is* the score. See Finding 3.
- **OR-Tools degrades on large orienteering instances.** Published benchmarks show it finding good solutions on small instances and struggling as size grows. At 30 to 80 candidate POIs per trip you are comfortably in the good regime. Do not scale the candidate set to thousands and expect quality.

### Drop the k-means clustering step

The draft proposes clustering POIs geographically, then routing each cluster as a separate day. Two problems:

- **k-means on raw lat/lng is geometrically wrong.** A degree of longitude at 40°N is about 85 km against 111 km for latitude, so Euclidean distance in degrees systematically distorts east-west. And straight-line distance is the thing the draft correctly rejects one section earlier.
- **It is redundant.** A multi-vehicle VRP with one vehicle per day *is* the clustering, solved jointly with the routing instead of greedily before it. Cluster-then-route locks in a partition the router then has to live with.

Model days as vehicles. If you later need to pre-partition for scale, cluster on the travel-time matrix (k-medoids), not on coordinates.

---

## Finding 3: There is no POI quality signal, and this is the actual product

Overture and Foursquare OS both ship without ratings, review counts, or popularity. The optimizer maximises collected score, and no dataset gives you a score.

Overture data quality also needs active defence. Documented issues: duplicate records, high junk rate, low property completeness, and positional error (businesses placed in the road, in backyards, on the beach). Roughly half of POIs scoring 0.75 to 0.85 confidence sit more than 100 m from their Google Maps position. Practical guidance converging in the community is to filter at **`confidence >= 0.6`** and dedupe. Confidence filters junk; it does nothing for duplicates or completeness.

### Build the score offline, cache it, keep runtime deterministic

- **Wikipedia / Wikidata pageviews** as a fame proxy. Free API, and it is unusually good for exactly your catalogue: national parks, landmarks, notable museums. A POI with a linked Wikidata entity and heavy traffic is worth visiting; one with neither probably is not.
- **OSM `tourism=*` tags** (`attraction`, `museum`, `viewpoint`, `artwork`) as a coarse "is this a destination" flag.
- **NPS designation** for anything in the park system.
- **A one-time LLM scoring pass** over the candidate set, per persona dimension: kid-friendly, romantic, outdoorsy, rainy-day. Run it once offline, write the scores to Postgres, never call it at request time. Runtime stays pure math and the LLM never touches the schedule.

This composite score is the thing that makes your itineraries different from a search box, and none of it comes out of a dataset. It is the moat, and it is the part the draft omits entirely. It also feeds directly into the `user_context` persona plan already parked in the project notes.

---

## Finding 4: Infrastructure, corrected for your actual stack

### Data: DuckDB offline, Postgres at runtime

The draft frames DuckDB and PostGIS as alternatives. They are different jobs.

**DuckDB is your ETL tool, not a runtime dependency.** It queries Overture's GeoParquet directly from S3 with `httpfs` + `spatial`, transferring only what your bounding box needs. Run it on your laptop, write out a curated set. Do not put it in the Cloud Run image: the filesystem is ephemeral, so a DuckDB file becomes a re-download on every cold start, and you would be running two databases.

One performance caveat: Overture's parquet row groups are not spatially ordered globally, so bbox pushdown is less effective than it looks. Put an explicit bbox predicate in the `WHERE` clause (`bbox.xmin > ... AND bbox.xmax < ...`) before any expensive `ST_Intersects`, so the cheap bounds check runs first.

**Neon supports the `postgis` extension**, so the curated output lands in the database you already run, with GIST indexes for radius queries. No new vendor, no new ops.

**Scope the ingest to your destinations, not to states.** The draft says "download the State of Utah," but `overturemaps-py` takes `--bbox`, not a state name. More importantly you already have `src/lib/destinations.ts` with about 60 US destinations, each with coordinates and a radius. Ingest a radius around each. After a `confidence >= 0.6` filter and a category whitelist that is a small table, not a data-engineering project.

**Licensing is clean but not free of obligations.** Overture places is CDLA-Permissive 2.0: commercial use is fine, no share-alike, no ODbL contamination (it contains no OSM data). But individual sources carry their own terms, and Foursquare-derived records require you to include the Apache 2.0 licence text and state that you modified the files with a date of change. Put that in your attribution page now rather than discovering it later.

### Routing: hosted Valhalla now, self-host later

Self-hosting Valhalla for the US is real infrastructure: roughly 15 to 20 GB of tiles on disk, a multi-hour tile build, and a stateful service that does not fit Cloud Run's model. (OSRM is worse for this shape: about 5× the PBF size in RAM, so roughly 50 GB for a US graph, in exchange for higher matrix throughput you do not need.)

At friends-and-family volume this is premature. **Use a hosted Valhalla instead.** Stadia Maps runs Valhalla, so the API surface is identical to a future self-hosted instance and migration is a base-URL change. `routingpy` abstracts both behind one interface, so you can swap without touching call sites. This preserves the zero-lock-in ethos that drove the MapLibre + Protomaps decision, without the ops.

Three operational notes:

- **Cache every matrix in Postgres**, keyed by a hash of the ordered coordinate list. Your POI set is small and static and the same hotel-to-POI pairs recur constantly, so most pairs get computed exactly once, ever. This is the difference between a real cost line and a rounding error.
- **Prefilter with Euclidean before paying for a matrix.** The draft is right that straight-line distance cannot schedule a trip, but it is a perfectly good filter for "is this POI plausibly in range." Cut 50 candidates to 20 by haversine, then buy one 21×21 matrix instead of 51×51.
- **Valhalla's `max_matrix_locations` defaults to 50** and is a per-side limit, so raise it in `service_limits` (or chunk requests) before it bites.
- **No OSM-based engine has live traffic.** Fine for interstate road trips, actively misleading for a Manhattan afternoon. If you ever do dense-city itineraries, inflate urban travel times by a time-of-day factor or accept that the schedule is optimistic.

---

## Finding 5: The LLM belongs at both ends, not just the back

The draft puts the LLM strictly after the solver. Half right. The middle must stay math, but the **front** is also a language problem: "we want a chill trip with a 5-year-old, no long drives" has to become a typed constraint struct before the solver can see it. Use structured outputs with a strict schema so the model returns a validated object, not prose you then parse.

```
free text  ──LLM──▶  Constraints{pace, daily_drive_cap, party, interests[], budget}
                          │
                     deterministic: POI query → score → matrix → OR-Tools
                          │
                     Itinerary JSON  ──LLM──▶  narration
```

Model choice: the draft's suggestions are two generations stale (Claude 3.5 Sonnet was retired in October 2025). For narration over a small verified JSON payload, **Claude Haiku 4.5** (`claude-haiku-4-5`, $1 / $5 per MTok, 200K context) is the right fit. Use a stronger model for the front-end constraint parsing if extraction accuracy matters, since that call is once per trip and its errors propagate into everything downstream.

Keep the draft's instruction to the narrator ("do not alter times or locations") and enforce it structurally: pass times as pre-formatted strings the model only echoes, and render them in the UI from the solver's JSON, never from the model's text.

---

## Revised sequencing

The draft is four phases of infrastructure before a single itinerary exists. Invert it, because the risk is not "can we route" (solved) but "are the trips any good" (unknown).

**Step 0. One destination, hand-made data.** Pick Moab or Sedona, both already in `destinations.ts`. Hand-curate 30 POIs with hand-entered hours, dwell times, and scores. Perfect data, zero pipeline.

**Step 1. Solver against that.** OR-Tools, days as vehicles, disjunctions with score penalties, hosted Valhalla matrix. Generate a 3-day itinerary. Read it as a human. If it is not a trip you would take with perfect hand-made data, no amount of Overture ingestion fixes it, and you have learned that for a week of work instead of a quarter.

**Step 2. Automate hours and scoring** for the categories that survived Step 1. NPS first, then category priors, then the offline scoring pass.

**Step 3. Automate POI ingestion.** DuckDB over Overture S3, per-destination radii, confidence filter, dedupe, load to Neon + PostGIS.

**Step 4. LLM at both ends.** Constraint parsing in front, narration behind.

Steps 2 and 3 are the draft's Phases 1 and 2, moved after you have evidence the output is worth industrialising.

---

## Pitfall log

| # | Pitfall | Mitigation |
|---|---|---|
| 1 | No opening hours in Overture or Foursquare OS | Tiered hours: NPS API, then category priors you author, then OSM `opening_hours` as a hint. Label unverified hours in the UI. |
| 2 | Google Places would solve hours + ratings, but its terms bar pairing Places content with a non-Google map, and cap lat/lng caching at 30 days | Do not use it. Incompatible with MapLibre + Protomaps and with owning the data. |
| 3 | TSPTW is infeasible by construction when candidates exceed a day | Model as TOPTW: `AddDisjunction` per POI, penalty = score, days = vehicles. |
| 4 | No ratings or popularity in either dataset | Composite offline score: Wikidata pageviews + OSM tourism tags + NPS designation + one-time LLM persona pass, cached in Postgres. |
| 5 | Overture junk, duplicates, and positional error (50% of 0.75–0.85 confidence POIs are >100 m off) | Filter `confidence >= 0.6`, dedupe on name + proximity, spot-check against the map before trusting a destination. |
| 6 | k-means on lat/lng distorts east-west and ignores road network | Drop it. Multi-vehicle VRP clusters and routes jointly. If needed later, k-medoids on the travel-time matrix. |
| 7 | Self-hosted Valhalla for the US is 15–20 GB of tiles and a stateful service; Cloud Run is stateless | Hosted Valhalla (identical API) until volume justifies the switch. `routingpy` keeps call sites portable. |
| 8 | Matrix calls are the recurring cost line | Cache by ordered-coordinate hash in Postgres; haversine prefilter before buying the matrix. |
| 9 | `max_matrix_locations` defaults to 50, per side | Raise in `service_limits` or chunk. |
| 10 | No live traffic on any OSM routing engine | Acceptable for road trips. Apply a time-of-day inflation factor for dense cities, or scope away from them. |
| 11 | Overture bbox pushdown is weak (row groups not spatially ordered) | Explicit bbox predicate in `WHERE` before `ST_Intersects`. |
| 12 | Foursquare-sourced Overture records carry an Apache 2.0 attribution and modification-notice obligation | Add to the attribution page alongside the CDLA-Permissive 2.0 notice. |
| 13 | Dwell time drives the schedule more than drive time, and has no data source | It is a table you author. Budget real time for it; treat it as a product asset, not a config file. |
| 14 | An LLM narrator can silently alter times | Pass times as pre-formatted strings to echo; render from solver JSON in the UI, never from model text. |
| 15 | OR-Tools quality degrades on large orienteering instances | Keep the candidate set to tens, not thousands. Prefilter aggressively by score and distance. |
| 16 | `overturemaps-py` is marked experimental and takes `--bbox` only, not place names | Fine as an ETL tool; pin the version. Per-destination bboxes from `destinations.ts`, not state names. |
| 17 | Overture's `categories` property is deprecated and removed in the Sept 2026 release | Write against `basic_category` / `taxonomy` from the start. Do not build on `categories`. |

---

## Ignored log

Things from the draft I deliberately dropped, downgraded, or reversed.

**Dropped outright**

- **k-means clustering for multi-day trips.** Superseded by multi-vehicle VRP, and geometrically unsound on raw coordinates. (Pitfall 6)
- **TSPTW as the problem model.** Replaced with TOPTW. Keeping TSPTW would produce a solver that is infeasible on nearly every real input.
- **"Download the State of Utah."** The CLI takes a bbox, not a state, and per-destination radii is the better scope regardless.
- **Llama 3 / Claude 3.5 Sonnet as the narration model.** Claude 3.5 Sonnet was retired in Oct 2025. Replaced with Haiku 4.5.

**Downgraded or deferred**

- **Self-hosting Valhalla in Docker now.** Right destination, wrong time. Hosted Valhalla has an identical API; migrate when volume warrants it.
- **DuckDB *or* PostGIS as a choice.** Reframed: DuckDB offline for ETL, Neon + PostGIS at runtime. Not competitors.
- **"Straight-line distance doesn't account for mountains, traffic, or road layouts."** True for scheduling, but Euclidean is still the correct cheap prefilter before paying for a matrix. Kept as a filter, rejected as a schedule input.

**Reversed**

- **"Once the algorithm outputs a spaced JSON schedule, your backend engineering is effectively done."** Rejected. At that point the two inputs that determine whether trips are good, dwell times and POI scores, do not exist yet. The routing is the commodity part; the curation is the product.
- **"Only now do you introduce the LLM."** Half rejected. The LLM belongs in front too, converting free text into typed constraints. It stays out of the middle.

**Noted but not acted on**

- **"Overture is backed by Meta and Amazon."** It is a Linux Foundation project with Meta, Amazon, Microsoft, and TomTom among steering members. Immaterial to the design.
- **Overture `operating_status`** (open / temporarily closed / permanently closed) is new and worth filtering on at ingest, but it is a lifecycle flag, not hours. It does not help the solver.

---

## Sources

- [Overture places schema reference](https://docs.overturemaps.org/schema/reference/places/place/)
- [Overture places guide and taxonomy](https://docs.overturemaps.org/guides/places/)
- [Overture attribution and licensing](https://docs.overturemaps.org/attribution/)
- [Overture DuckDB access](https://docs.overturemaps.org/getting-data/duckdb/)
- [overturemaps-py](https://github.com/OvertureMaps/overturemaps-py)
- [Overture data quality analysis (Echo)](https://www.echo-analytics.com/blog/analyzing-overture-maps-foundations-places-data)
- [Overture confidence values discussion](https://github.com/orgs/OvertureMaps/discussions/434)
- [Foursquare OS Places schema](https://docs.foursquare.com/data-products/docs/places-os-data-schema)
- [Google Maps Platform service-specific terms](https://cloud.google.com/maps-platform/terms/maps-service-terms)
- [NPS API documentation](https://www.nps.gov/subjects/developer/api-documentation.htm)
- [OSM Key:opening_hours](https://wiki.openstreetmap.org/wiki/Key:opening_hours)
- [Valhalla matrix API](https://valhalla.github.io/valhalla/api/matrix/)
- [Valhalla max_matrix_locations issue](https://github.com/valhalla/valhalla/issues/3566)
- [Self-hosted routing engines compared, 2026](https://www.pistack.xyz/posts/2026-04-25-graphhopper-vs-osrm-vs-valhalla-self-hosted-routing-engines-guide-2026/)
- [OR-Tools vehicle routing](https://developers.google.com/optimization/routing/vrp)
- [OR-Tools disjunctions explained](https://activimetrics.com/blog/ortools/exploring_disjunctions/)
- [Hexaly / Gurobi / OR-Tools on the Team Orienteering Problem](https://www.hexaly.com/benchmarks/hexaly-gurobi-or-tools-team-orienteering-problem-top)
- [Cluster-based heuristics for TOPTW](https://link.springer.com/chapter/10.1007/978-3-642-38527-8_34)
- [Tourist trip design problem with time windows](https://www.sciencedirect.com/science/article/pii/S156849462400173X)
- [Neon PostGIS extension](https://neon.com/docs/extensions/postgis)
