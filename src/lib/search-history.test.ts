import { describe, expect, it } from "vitest";

import {
  DEDUPE_WINDOW_MS,
  sameSearch,
  shouldRecord,
  type SearchQuery,
} from "./search-history";

const AUSTIN: SearchQuery = { dest: "austin", checkin: "2026-09-18", nights: 2, adults: 2 };
const at = (ms: number) => new Date(Date.UTC(2026, 7, 22, 12, 0, 0) + ms);
const T0 = at(0);

describe("sameSearch", () => {
  it("is the guest's idea of the same search, not the URL's", () => {
    expect(sameSearch(AUSTIN, { ...AUSTIN, dest: "  AUSTIN " })).toBe(true);
  });

  it("separates searches that would return different results", () => {
    expect(sameSearch(AUSTIN, { ...AUSTIN, dest: "nola" })).toBe(false);
    expect(sameSearch(AUSTIN, { ...AUSTIN, checkin: "2026-09-19" })).toBe(false);
    expect(sameSearch(AUSTIN, { ...AUSTIN, nights: 3 })).toBe(false);
    expect(sameSearch(AUSTIN, { ...AUSTIN, adults: 4 })).toBe(false);
  });

  it("ignores free-text notes", () => {
    // Two people typing "quiet room" and "somewhere quiet" are asking the same
    // question of the catalogue; splitting history on prose would make the list
    // useless.
    expect(sameSearch(AUSTIN, { ...AUSTIN, notes: "quiet room" })).toBe(true);
  });
});

describe("shouldRecord", () => {
  it("records the first search a guest ever makes", () => {
    expect(shouldRecord(AUSTIN, null, T0)).toBe(true);
  });

  it("records a genuinely different search immediately", () => {
    const last = { query: { ...AUSTIN, dest: "nola" }, at: T0 };
    expect(shouldRecord(AUSTIN, last, at(1000))).toBe(true);
  });

  it("suppresses a refresh, a back-navigation, or a prefetch", () => {
    // The write happens during a server render of a GET, so the same URL can
    // arrive several times for one human action. Without this, "recent
    // searches" becomes twelve copies of one search.
    const last = { query: AUSTIN, at: T0 };
    expect(shouldRecord(AUSTIN, last, at(0))).toBe(false);
    expect(shouldRecord(AUSTIN, last, at(1000))).toBe(false);
    expect(shouldRecord(AUSTIN, last, at(DEDUPE_WINDOW_MS - 1))).toBe(false);
  });

  it("records the same search again once the window has passed", () => {
    // Coming back to the same trip hours later is a real signal, not a repeat.
    const last = { query: AUSTIN, at: T0 };
    expect(shouldRecord(AUSTIN, last, at(DEDUPE_WINDOW_MS))).toBe(true);
    expect(shouldRecord(AUSTIN, last, at(DEDUPE_WINDOW_MS * 4))).toBe(true);
  });

  it("honours a caller-supplied window", () => {
    const last = { query: AUSTIN, at: T0 };
    expect(shouldRecord(AUSTIN, last, at(5_000), 10_000)).toBe(false);
    expect(shouldRecord(AUSTIN, last, at(15_000), 10_000)).toBe(true);
  });

  it("compares against the LAST search only, not the whole history", () => {
    // Austin, then New Orleans, then Austin again is three real searches. The
    // dedupe must not swallow the third just because Austin appears earlier.
    const last = { query: { ...AUSTIN, dest: "nola" }, at: at(60_000) };
    expect(shouldRecord(AUSTIN, last, at(61_000))).toBe(true);
  });
});
