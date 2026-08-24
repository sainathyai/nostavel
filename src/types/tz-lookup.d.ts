// tz-lookup ships no types. It is a single CommonJS function: coordinates in,
// IANA zone name out, entirely offline (a packed 150 KB table, no network, no
// key). Chosen over geo-tz, which is more precise at coastlines but unpacks to
// 73 MB for an accuracy we do not need to name a hotel's clock.
declare module "tz-lookup" {
  /** Throws on out-of-range coordinates rather than returning null. */
  export default function tzlookup(lat: number, lon: number): string;
}
