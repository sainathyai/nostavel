// US destinations, searched by perimeter (lat/lng + radius in metres) so nearby
// towns fall inside the search area. Curated: major cities, tourist towns, and
// national-park gateways. Plain data, importable by server and client.
export type DestType = "city" | "town" | "park";
export type Destination = {
  key: string;
  name: string;
  region: string; // US state, for the typeahead subtitle
  label: string; // "Name, ST"
  lat: number;
  lng: number;
  radius: number; // metres
  type: DestType;
};

function d(
  key: string,
  name: string,
  region: string,
  lat: number,
  lng: number,
  radius: number,
  type: DestType,
): Destination {
  return { key, name, region, label: `${name}, ${region}`, lat, lng, radius, type };
}

export const DESTINATIONS: Destination[] = [
  // --- major cities ---
  d("nyc", "New York", "NY", 40.758, -73.9855, 9000, "city"),
  d("losangeles", "Los Angeles", "CA", 34.0522, -118.2437, 13000, "city"),
  d("sanfrancisco", "San Francisco", "CA", 37.7749, -122.4194, 7000, "city"),
  d("chicago", "Chicago", "IL", 41.8781, -87.6298, 9000, "city"),
  d("lasvegas", "Las Vegas", "NV", 36.1147, -115.1728, 8000, "city"),
  d("miami", "Miami", "FL", 25.7743, -80.1937, 10000, "city"),
  d("miamibeach", "Miami Beach", "FL", 25.79, -80.13, 6000, "town"),
  d("orlando", "Orlando", "FL", 28.5383, -81.3792, 14000, "city"),
  d("washington", "Washington", "DC", 38.9072, -77.0369, 8000, "city"),
  d("boston", "Boston", "MA", 42.3601, -71.0589, 8000, "city"),
  d("seattle", "Seattle", "WA", 47.6062, -122.3321, 9000, "city"),
  d("sandiego", "San Diego", "CA", 32.7157, -117.1611, 11000, "city"),
  d("neworleans", "New Orleans", "LA", 29.9511, -90.0715, 7000, "city"),
  d("nashville", "Nashville", "TN", 36.1627, -86.7816, 9000, "city"),
  d("austin", "Austin", "TX", 30.2672, -97.7431, 10000, "city"),
  d("denver", "Denver", "CO", 39.7392, -104.9903, 10000, "city"),
  d("honolulu", "Honolulu", "HI", 21.2793, -157.8293, 9000, "city"),
  d("atlanta", "Atlanta", "GA", 33.749, -84.388, 11000, "city"),
  d("philadelphia", "Philadelphia", "PA", 39.9526, -75.1652, 9000, "city"),
  d("portland", "Portland", "OR", 45.5152, -122.6784, 9000, "city"),
  d("phoenix", "Phoenix", "AZ", 33.4484, -112.074, 14000, "city"),
  d("scottsdale", "Scottsdale", "AZ", 33.4942, -111.9261, 9000, "town"),
  d("dallas", "Dallas", "TX", 32.7767, -96.797, 12000, "city"),
  d("houston", "Houston", "TX", 29.7604, -95.3698, 13000, "city"),
  d("sanantonio", "San Antonio", "TX", 29.4241, -98.4936, 9000, "city"),
  d("savannah", "Savannah", "GA", 32.0809, -81.0912, 6000, "city"),
  d("charleston", "Charleston", "SC", 32.7765, -79.9311, 7000, "city"),

  // --- tourist towns & resort areas ---
  d("aspen", "Aspen", "CO", 39.1911, -106.8175, 12000, "town"),
  d("vail", "Vail", "CO", 39.6403, -106.3742, 9000, "town"),
  d("napa", "Napa", "CA", 38.2975, -122.2869, 14000, "town"),
  d("sonoma", "Sonoma", "CA", 38.2919, -122.458, 12000, "town"),
  d("sedona", "Sedona", "AZ", 34.8697, -111.761, 13000, "town"),
  d("keywest", "Key West", "FL", 24.5551, -81.78, 6000, "town"),
  d("palmsprings", "Palm Springs", "CA", 33.8303, -116.5453, 12000, "town"),
  d("santafe", "Santa Fe", "NM", 35.687, -105.9378, 9000, "town"),
  d("jacksonhole", "Jackson Hole", "WY", 43.4799, -110.7624, 16000, "town"),
  d("parkcity", "Park City", "UT", 40.6461, -111.498, 9000, "town"),
  d("laketahoe", "Lake Tahoe", "CA", 38.9399, -119.9772, 18000, "town"),
  d("gatlinburg", "Gatlinburg", "TN", 35.7143, -83.5102, 11000, "town"),
  d("asheville", "Asheville", "NC", 35.5951, -82.5515, 12000, "town"),
  d("myrtlebeach", "Myrtle Beach", "SC", 33.6891, -78.8867, 9000, "town"),
  d("newport", "Newport", "RI", 41.4901, -71.3128, 7000, "town"),
  d("barharbor", "Bar Harbor", "ME", 44.3876, -68.2039, 12000, "town"),
  d("carmel", "Carmel-by-the-Sea", "CA", 36.5552, -121.9233, 9000, "town"),
  d("santabarbara", "Santa Barbara", "CA", 34.4208, -119.6982, 10000, "town"),
  d("monterey", "Monterey", "CA", 36.6002, -121.8947, 10000, "town"),
  d("moab", "Moab", "UT", 38.5733, -109.5498, 16000, "town"),
  d("telluride", "Telluride", "CO", 37.9375, -107.8123, 9000, "town"),
  d("breckenridge", "Breckenridge", "CO", 39.4817, -106.0384, 9000, "town"),
  d("stowe", "Stowe", "VT", 44.4654, -72.6874, 11000, "town"),
  d("branson", "Branson", "MO", 36.6437, -93.2185, 11000, "town"),
  d("hiltonhead", "Hilton Head", "SC", 32.2163, -80.7526, 11000, "town"),
  d("destin", "Destin", "FL", 30.3935, -86.4958, 11000, "town"),
  d("naples", "Naples", "FL", 26.142, -81.7948, 11000, "town"),
  d("bigsur", "Big Sur", "CA", 36.2704, -121.8081, 16000, "town"),

  // --- national-park gateways ---
  d("grandcanyon", "Grand Canyon", "AZ", 36.0544, -112.1401, 22000, "park"),
  d("yellowstone", "Yellowstone", "WY", 44.6621, -111.1041, 40000, "park"),
  d("yosemite", "Yosemite", "CA", 37.8651, -119.5383, 30000, "park"),
  d("zion", "Zion", "UT", 37.2982, -113.0263, 16000, "park"),
  d("grandteton", "Grand Teton", "WY", 43.7904, -110.6818, 26000, "park"),
  d("rockymountain", "Rocky Mountain (Estes Park)", "CO", 40.3772, -105.5217, 14000, "park"),
  d("glacier", "Glacier", "MT", 48.4959, -113.9838, 32000, "park"),
  d("brycecanyon", "Bryce Canyon", "UT", 37.593, -112.1871, 16000, "park"),
];

export const DEST_BY_KEY = new Map(DESTINATIONS.map((x) => [x.key, x]));
