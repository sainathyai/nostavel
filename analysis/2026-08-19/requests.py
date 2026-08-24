#!/usr/bin/env python
"""LiteAPI search parameters — the complete accepted set, annotated.

Fresh start, 2026-08-19.

  POST /hotels/rates       the full rate search. Parameters, requirements,
                           defaults and enums below come from LiteAPI's
                           OpenAPI schema.

  POST /hotels/min-rates   an extension of /hotels/rates that returns ONE
                           cheapest offer per hotel instead of the full
                           roomTypes tree, so it takes the same body. It does
                           not appear in LiteAPI's published endpoint list.
                           See the notes at the bottom for the deviations
                           actually observed on 2026-08-19.

Values shown are the spec's own examples unless a comment says otherwise.
Comments starting REQUIRED mark schema-required fields.
"""

# =============================================================================
# POST /hotels/rates
# =============================================================================
RATES = {
    # -------------------------------------------------------------------------
    # REQUIRED  (the OpenAPI `required` array: occupancies, currency,
    #            guestNationality, checkin, checkout)
    # -------------------------------------------------------------------------
    "occupancies": [                  # REQUIRED. One object per ROOM.
        {
            "adults": 2,              # REQUIRED inside each occupancy object
            "children": [11, 5],      # optional: AGES of children, not a count
        },
        {"adults": 1},                # a second object books a second room
    ],
    "currency": "USD",                # REQUIRED
    "guestNationality": "US",         # REQUIRED. ISO 2-letter country code
    "checkin": "2026-09-18",          # REQUIRED. YYYY-MM-DD (ISO 8601)
    "checkout": "2026-09-20",         # REQUIRED. YYYY-MM-DD (ISO 8601)

    # -------------------------------------------------------------------------
    # LOCATION
    #
    # These are not nine interchangeable options. They split into ANCHORS,
    # which can start a search on their own, and MODIFIERS, which only narrow
    # an anchor and return 400 if sent alone.
    #
    # Supply exactly ONE anchor. Omitting every anchor returns HTTP 400 with
    # the API's own list of them:
    #
    #     "you must search by either country code, latitude and longitude,
    #      placeId, lastUpdatedAt, IATA code, or hotelIds"
    #
    # All rows below verified live 2026-08-19 against /hotels/rates.
    #
    #   ANCHOR                          alone?   notes
    #   hotelIds                        200      most specific
    #   countryCode                     200      whole country if unnarrowed
    #   latitude + longitude            200      radius NOT required
    #   placeId                         200
    #   iataCode                        200
    #   aiSearch                        200      works, though the error text
    #                                            above does not name it
    #   lastUpdatedAt                   ?        named in the error text but
    #                                            absent from the OpenAPI
    #                                            request schema; untested
    #
    #   MODIFIER                        alone?   requires
    #   cityName                        400      countryCode
    #   radius                          n/a      latitude + longitude
    # -------------------------------------------------------------------------

    # --- anchor 1: explicit hotels (from GET /data/hotels) ---
    "hotelIds": ["lp225d01"],

    # --- anchor 2: country, optionally narrowed to a city ---
    "countryCode": "US",              # ISO 2-letter. Valid anchor on its own
    "cityName": "Asheville",          # MODIFIER — 400 without countryCode

    # --- anchor 3: coordinates, optionally narrowed by a radius ---
    "latitude": 35.5951,              # anchor is latitude + longitude together
    "longitude": -82.5515,
    "radius": 8000,                   # MODIFIER, metres. Optional: lat+lng
                                      # alone returns 200

    # --- anchors 4-6: single-parameter lookups ---
    "iataCode": "AVL",                # airport / location code
    "placeId": "ChIJYeZuBI9YwokRjMDs_IEyCwo",       # Google Place ID
    "aiSearch": "boutique hotel near downtown Asheville",  # natural language

    # -------------------------------------------------------------------------
    # RESPONSE SIZE AND SHAPE
    # -------------------------------------------------------------------------
    # Rooms returned PER HOTEL, "sorted by price (cheapest first)". Set 1 for a
    # listing page. If the response returns exactly this many, you are
    # truncating: a single hotel can hold 1,300+ plans.
    "maxRatesPerHotel": 50,
    "limit": 200,                     # hotels returned. DEFAULT 200, MAX 5000
    "offset": 0,                      # DEFAULT 0. Paginates the hotels passed
                                      # in, not the rates returned
    # How long LiteAPI waits for SUPPLIERS to answer — not your HTTP timeout.
    # Spec recommends 6-12 seconds.
    "timeout": 10,
    "stream": False,                  # DEFAULT false. Incremental response
    # Hotel name/photo/address/rating come back automatically on FILTER
    # searches (cityName, aiSearch, …) but NOT on a direct hotelIds search
    # unless this is set.
    "includeHotelData": True,         # DEFAULT false
    "roomMapping": True,              # DEFAULT false. Adds mappedRoomId,
                                      # linking a rate to a room in /data/hotel

    # -------------------------------------------------------------------------
    # SORTING — default is top_picks, NOT price.
    # (maxRatesPerHotel is cheapest-first, but that ordering is WITHIN a hotel.)
    # -------------------------------------------------------------------------
    "sort": [
        {
            "field": "top_picks",     # REQUIRED in each sort object.
                                      # enum: top_picks | price | revenue
                                      #   top_picks = search popularity, review
                                      #               quality, content
                                      #               completeness  (DEFAULT)
                                      #   price     = room rate
                                      #   revenue   = historical booking value
            "direction": "ascending",  # enum: ascending | descending
        }
    ],

    # -------------------------------------------------------------------------
    # RATE-LEVEL FILTERS
    # -------------------------------------------------------------------------
    # Single value "BI" or comma-separated "BI,HB" for OR logic.
    #   RO  Room Only              BI  Breakfast Included
    #   HB  Half Board             FB  Full Board
    #   AI  All Inclusive          DI  Dinner Included
    #   LI  Lunch Included         BDI Breakfast and Dinner Included
    #   BLI Breakfast and Lunch    LDI Lunch and Dinner Included
    "boardType": "RO,BI",
    "refundableRatesOnly": False,     # DEFAULT false. true = only RFN rates
    "bedTypes": ["king", "queen"],    # matched against room NAMES.
                                      # e.g. double, twin, king, queen, single
    # Grouped amenity filter: '-' is OR within a group, ',' is AND across
    # groups. "1-2,3-4" means (1 OR 2) AND (3 OR 4).
    # Takes precedence over roomAmenities + amenityFilterLogic.
    "roomAmenitiesFilter": "1-2,3-4",
    "roomAmenities": [1, 2, 3],       # LEGACY. Ignored if the above is set
    "amenityFilterLogic": "AND",      # LEGACY. enum: AND | OR

    # -------------------------------------------------------------------------
    # HOTEL-LEVEL FILTERS — applied on top of the main location query
    # -------------------------------------------------------------------------
    "hotelName": "Kimpton",           # case-insensitive substring
    "starRating": [4, 5],             # rounded to nearest half-star
    "minRating": 4.5,                 # 0-5 scale
    "minReviewsCount": 100,
    "zip": "28801",
    "hotelTypeIds": [201, 204, 208],  # GET /data/hotelTypes
    "chainIds": [14675, 14677],       # GET /data/chains
    "facilities": [1, 2, 3],          # GET /data/facilities. OR logic by default
    "strictFacilityFiltering": False,  # DEFAULT false. true = must have ALL
    "advancedAccessibilityOnly": False,  # DEFAULT false

    # -------------------------------------------------------------------------
    # COMMERCIAL
    # -------------------------------------------------------------------------
    # Our markup as a PERCENTAGE (10 = 10%). Overrides the account-level margin
    # for this request only. Omitting it applies the account default, which may
    # be 0. Per-REQUEST, never per-offer — and /rates/prebook accepts no margin.
    "margin": 12,
    # Only has an effect if price consistency is enabled on the account. Same
    # sessionId + same checkin/checkout across a session keeps prices stable.
    "sessionId": "pc-session-3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    "feed": "custom_feed",            # multi-feed accounts only

    # -------------------------------------------------------------------------
    # LOYALTY
    # -------------------------------------------------------------------------
    "loyaltyProgram": "HH",           # e.g. HH = Hilton Honors
    "loyaltyProgramDetails": [
        {
            "membershipId": "814125083",  # REQUIRED in each entry
            "programId": "HH",            # REQUIRED in each entry
        }
    ],
}


# =============================================================================
# POST /hotels/min-rates
# =============================================================================
# An extension of /hotels/rates: same request body, but the response is one
# object per hotel — {hotelId, price, suggestedSellingPrice, offerId} — rather
# than the full roomTypes tree. Much smaller payload than
# /hotels/rates + maxRatesPerHotel=1, and the offerId is a real bookable offer.
#
# Undocumented: it does not appear in LiteAPI's published endpoint list, so
# everything here is observed behaviour that could change without notice.
#
# Deviations actually observed on 2026-08-19:
#
#   * Geo search needs countryCode alongside the coordinates. Sending
#     latitude/longitude/radius on their own returns:
#         4003 "country can't be empty if geo coordinates are defined"
#     which is a stricter requirement than /hotels/rates imposes.
#
#   * A location that resolves to nothing returns
#         4000 "empty hotel ids or hotels not found for your search"
#     rather than an empty 200. Do not read that 400 as "parameter
#     unsupported" — it means the lookup found no hotels.
#
#   * Confirmed working: hotelIds, occupancies, currency, guestNationality,
#     checkin, checkout, timeout, refundableRatesOnly, boardType.
#
#   * Removing any of hotelIds / occupancies / currency / guestNationality /
#     checkin returns 400, so those are required. checkout could not be
#     isolated (the probe hit a 429) but is structurally required.
#
# Reuse RATES and override what differs.
MIN_RATES = {
    **RATES,
    "hotelIds": ["lp225d01", "lpaf03a"],
}
