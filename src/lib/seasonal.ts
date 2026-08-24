// Curated, season-aware destination inspiration for the landing page. This is the
// cold-start experience: instead of dumping hotels for one city, we recommend a
// handful of places worth going *right now*, by time of year. Plain data — no API
// calls at render time (destination images are baked below), so the homepage is
// instant. Each destination `key` matches a DESTINATIONS entry so a click runs the
// curated perimeter search for that place.
import { DEST_BY_KEY } from "./destinations";

const STATE_NAME: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "Washington, D.C.",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon",
  PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia",
  WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

// Representative photo per destination (a top hotel's exterior from LiteAPI's CDN).
// Baked so the homepage makes zero API calls. Regenerate with scripts/dest-images.
export const DEST_IMAGES: Record<string, string> = {
  asheville: "https://static.cupid.travel/hotels/ex_fecf86cc_z.jpg",
  gatlinburg: "https://static.cupid.travel/hotels/293495219.jpg",
  stowe: "https://static.cupid.travel/hotels/333104985.jpg",
  barharbor: "https://static.cupid.travel/hotels/305040922.jpg",
  aspen: "https://static.cupid.travel/hotels/25119362.jpg",
  laketahoe: "https://static.cupid.travel/hotels/63505742.jpg",
  branson: "https://static.cupid.travel/hotels/154003302.jpg",
  yellowstone: "https://static.cupid.travel/hotels/167428563.jpg",
  grandteton: "https://static.cupid.travel/hotels/98722030.jpg",
  glacier: "https://static.cupid.travel/hotels/271146953.jpg",
  yosemite: "https://static.cupid.travel/hotels/322410352.jpg",
  rockymountain: "https://static.cupid.travel/hotels/585478945.jpg",
  zion: "https://static.cupid.travel/hotels/253588740.jpg",
  sandiego: "https://static.cupid.travel/hotels/511143696.jpg",
  destin: "https://static.cupid.travel/hotels/173352236.jpg",
  myrtlebeach: "https://static.cupid.travel/hotels/526133207.jpg",
  hiltonhead: "https://static.cupid.travel/hotels/341650702.jpg",
  newport: "https://static.cupid.travel/hotels/487592645.jpg",
  napa: "https://static.cupid.travel/hotels/410139409.jpg",
  sonoma: "https://static.cupid.travel/hotels/100299747.jpg",
  vail: "https://static.cupid.travel/hotels/283245406.jpg",
  parkcity: "https://static.cupid.travel/hotels/216138623.jpg",
  breckenridge: "https://static.cupid.travel/hotels/232630018.jpg",
  jacksonhole: "https://static.cupid.travel/hotels/330658534.jpg",
  miamibeach: "https://static.cupid.travel/hotels/489331754.jpg",
  keywest: "https://static.cupid.travel/hotels/214302758.jpg",
  naples: "https://static.cupid.travel/hotels/220888921.jpg",
  scottsdale: "https://static.cupid.travel/hotels/37633564.jpg",
  palmsprings: "https://static.cupid.travel/hotels/606051907.jpg",
  honolulu: "https://static.cupid.travel/hotels/493660776.jpg",
  sedona: "https://static.cupid.travel/hotels/59662316.jpg",
  moab: "https://static.cupid.travel/hotels/268755755.jpg",
  grandcanyon: "https://static.cupid.travel/hotels/555786011.jpg",
  santafe: "https://static.cupid.travel/hotels/42894769.jpg",
  charleston: "https://static.cupid.travel/hotels/19781257.jpg",
  savannah: "https://static.cupid.travel/hotels/541055281.jpg",
  washington: "https://static.cupid.travel/hotels/129995170.jpg",
  nyc: "https://static.cupid.travel/hotels/599791912.jpg",
  neworleans: "https://static.cupid.travel/hotels/282791032.jpg",
  nashville: "https://static.cupid.travel/hotels/269828937.jpg",
  austin: "https://static.cupid.travel/hotels/427229730.jpg",
  lasvegas: "https://static.cupid.travel/hotels/44103227.jpg",
  sanfrancisco: "https://static.cupid.travel/hotels/532634628.jpg",
};

type ThemeDest = { key: string; blurb: string };
type Theme = {
  key: string;
  title: string;
  blurb: string;
  badge: string; // urgency cue shown on the row, e.g. "Book now" / "Book early"
  months: number[]; // 1-12 in which this theme is featured
  dests: ThemeDest[];
};

// Ordered by how strongly each reads as "the thing to do now"; the resolver keeps
// this order. Keys must exist in DESTINATIONS.
const THEMES: Theme[] = [
  {
    key: "fall-foliage",
    title: "Fall color, book it early",
    blurb: "Peak leaf season fills up fast. The mountains and New England at their best.",
    badge: "Book now",
    months: [8, 9, 10, 11],
    dests: [
      { key: "asheville", blurb: "Blue Ridge Parkway ablaze" },
      { key: "gatlinburg", blurb: "Great Smoky Mountains gateway" },
      { key: "stowe", blurb: "Vermont's classic leaf run" },
      { key: "barharbor", blurb: "Acadia's coast turns gold" },
      { key: "aspen", blurb: "Aspens gone bright yellow" },
      { key: "laketahoe", blurb: "Alpine color on the water" },
    ],
  },
  {
    key: "thanksgiving-smokies",
    title: "Thanksgiving in the Smokies",
    blurb: "Cabins, ridgeline views, and a long weekend that books out early.",
    badge: "Book now",
    months: [10, 11],
    dests: [
      { key: "gatlinburg", blurb: "Cabin country by the park" },
      { key: "asheville", blurb: "Mountain town with a table for everyone" },
      { key: "branson", blurb: "Ozarks lights and a full holiday spread" },
    ],
  },
  {
    key: "national-parks",
    title: "National parks at their peak",
    blurb: "Long days, open roads, and every trail in season.",
    badge: "In season",
    months: [5, 6, 7, 8, 9],
    dests: [
      { key: "yellowstone", blurb: "Geysers and open valleys" },
      { key: "grandteton", blurb: "The sharpest skyline in the Rockies" },
      { key: "glacier", blurb: "Going-to-the-Sun in full swing" },
      { key: "yosemite", blurb: "Granite walls and high country" },
      { key: "rockymountain", blurb: "Alpine air out of Estes Park" },
      { key: "zion", blurb: "Red canyon before the crowds cool it" },
    ],
  },
  {
    key: "summer-coast",
    title: "Last of the summer coast",
    blurb: "Warm water and quiet beaches before the season turns.",
    badge: "Ending soon",
    months: [6, 7, 8, 9],
    dests: [
      { key: "sandiego", blurb: "Endless-summer beaches" },
      { key: "destin", blurb: "Emerald-green Gulf water" },
      { key: "myrtlebeach", blurb: "Wide sand, easy pace" },
      { key: "hiltonhead", blurb: "Low-country bike-and-beach days" },
      { key: "newport", blurb: "Cliff Walk and sailing light" },
      { key: "barharbor", blurb: "Cool Maine coast in bloom" },
    ],
  },
  {
    key: "wine-harvest",
    title: "Wine country at harvest",
    blurb: "Crush season. The vineyards are working and the tables are long.",
    badge: "In season",
    months: [9, 10],
    dests: [
      { key: "napa", blurb: "Cabernet country mid-harvest" },
      { key: "sonoma", blurb: "Quieter, greener, just as good" },
    ],
  },
  {
    key: "ski",
    title: "Ski season is open",
    blurb: "Fresh snow, warm lodges, and the lifts running.",
    badge: "Book early",
    months: [12, 1, 2, 3],
    dests: [
      { key: "aspen", blurb: "Four mountains, one town" },
      { key: "vail", blurb: "The Back Bowls on a bluebird day" },
      { key: "parkcity", blurb: "Ski-in and walkable Main Street" },
      { key: "breckenridge", blurb: "High peaks, easy vibe" },
      { key: "jacksonhole", blurb: "Steep and deep by the Tetons" },
      { key: "stowe", blurb: "New England's ski classic" },
    ],
  },
  {
    key: "winter-sun",
    title: "Trade winter for sun",
    blurb: "Where it's warm while the rest of the map freezes.",
    badge: "In season",
    months: [11, 12, 1, 2, 3],
    dests: [
      { key: "miamibeach", blurb: "Art Deco and 80 degrees" },
      { key: "keywest", blurb: "End-of-the-road island calm" },
      { key: "naples", blurb: "Gulf sunsets, glassy water" },
      { key: "scottsdale", blurb: "Desert warmth and resort pools" },
      { key: "palmsprings", blurb: "Mid-century sun by the mountains" },
      { key: "honolulu", blurb: "Trade winds and Waikiki" },
    ],
  },
  {
    key: "desert-spring",
    title: "Red rock & desert spring",
    blurb: "The sweet spot. Warm days, cool nights, wildflowers on the trails.",
    badge: "In season",
    months: [3, 4, 5],
    dests: [
      { key: "sedona", blurb: "Red rock at every turn" },
      { key: "moab", blurb: "Arches and slickrock" },
      { key: "zion", blurb: "The Narrows before summer heat" },
      { key: "grandcanyon", blurb: "The rim in perfect weather" },
      { key: "santafe", blurb: "High-desert art and adobe" },
      { key: "palmsprings", blurb: "Pools before it gets hot" },
    ],
  },
  {
    key: "southern-spring",
    title: "The South in bloom",
    blurb: "Gardens, porches, and warm evenings before the humidity arrives.",
    badge: "In season",
    months: [3, 4, 5],
    dests: [
      { key: "charleston", blurb: "Antebellum streets in flower" },
      { key: "savannah", blurb: "Live oaks and Spanish moss" },
      { key: "washington", blurb: "Cherry blossoms on the Tidal Basin" },
      { key: "napa", blurb: "Green hills before the crowds" },
    ],
  },
];

export type AtmosphereVariant = "leaves" | "snow" | "petals" | "none";

// Deliberately sparse: most themes get no hero effect at all. A gimmick on
// every row would read as decoration, not as the app noticing the season —
// see the design note in Experience.tsx's hero section.
const ATMOSPHERE_BY_THEME: Record<string, AtmosphereVariant> = {
  "fall-foliage": "leaves",
  "thanksgiving-smokies": "leaves",
  ski: "snow",
  "southern-spring": "petals",
};

export function themeAtmosphere(themeKey: string): AtmosphereVariant {
  return ATMOSPHERE_BY_THEME[themeKey] ?? "none";
}

// A quiet warm-twinkle layer, independent of the falling-particle variant —
// runs Dec 1-26 regardless of which theme is leading (ski or winter-sun),
// since neither implies the holiday on its own.
export function isHolidayWindow(now: Date = new Date()): boolean {
  return now.getMonth() + 1 === 12 && now.getDate() <= 26;
}

// Always available — a stable fallback / "popular anytime" row.
const EVERGREEN: Theme = {
  key: "popular-anytime",
  title: "Always a good idea",
  blurb: "City favorites that work in any season.",
  badge: "Popular",
  months: [],
  dests: [
    { key: "nyc", blurb: "The one that never misses" },
    { key: "neworleans", blurb: "Music, food, and a walkable core" },
    { key: "nashville", blurb: "Honky-tonks and hot chicken" },
    { key: "austin", blurb: "Tacos, trails, and live sets" },
    { key: "lasvegas", blurb: "Big rooms, bigger nights" },
    { key: "sanfrancisco", blurb: "Fog, hills, and great tables" },
  ],
};

export type SeasonalDestination = {
  key: string;
  name: string;
  region: string;
  blurb: string;
  image: string | null;
};

export type SeasonalSection = {
  key: string;
  title: string;
  blurb: string;
  badge: string;
  destinations: SeasonalDestination[];
};

function hydrate(theme: Theme): SeasonalSection {
  const destinations: SeasonalDestination[] = [];
  for (const t of theme.dests) {
    const d = DEST_BY_KEY.get(t.key);
    if (!d) continue;
    destinations.push({
      key: d.key,
      name: d.name,
      region: STATE_NAME[d.region] ?? d.region,
      blurb: t.blurb,
      image: DEST_IMAGES[d.key] ?? null,
    });
  }
  return { key: theme.key, title: theme.title, blurb: theme.blurb, badge: theme.badge, destinations };
}

// The sections to feature right now. Themes active this month, in priority order,
// capped, with the evergreen row appended so there's always something to browse.
export function getSeasonalSections(now: Date = new Date(), max = 4): SeasonalSection[] {
  const month = now.getMonth() + 1;
  const active = THEMES.filter((t) => t.months.includes(month)).slice(0, max - 1);
  const sections = active.map(hydrate).filter((s) => s.destinations.length > 0);
  sections.push(hydrate(EVERGREEN));
  return sections;
}

// Every destination key referenced above — used by the image-baking script.
export function allSeasonalKeys(): string[] {
  const set = new Set<string>();
  for (const t of [...THEMES, EVERGREEN]) for (const d of t.dests) set.add(d.key);
  return [...set];
}
