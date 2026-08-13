import { describe, it, expect } from "vitest";
import { levenshtein, fuzzyThreshold } from "./fuzzy";

describe("levenshtein", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshtein("austin", "austin")).toBe(0);
  });

  it("computes real edit distance within the bound", () => {
    expect(levenshtein("nashvile", "nashville")).toBe(1); // one deletion
    expect(levenshtein("austn", "austin")).toBe(1); // one insertion
    expect(levenshtein("kitten", "sitting", 5)).toBe(3);
  });

  it("bails out early (returns max+1) once a string pair can't possibly fit the bound", () => {
    expect(levenshtein("a", "abcdefgh", 3)).toBe(4);
  });

  it("bails out mid-computation when every row exceeds the bound", () => {
    expect(levenshtein("aaaaaaaaaa", "bbbbbbbbbb", 3)).toBe(4);
  });

  it("is symmetric", () => {
    expect(levenshtein("chicago", "chcago")).toBe(levenshtein("chcago", "chicago"));
  });
});

describe("fuzzyThreshold", () => {
  it("is 1 for short queries (<=7 chars)", () => {
    expect(fuzzyThreshold(1)).toBe(1);
    expect(fuzzyThreshold(7)).toBe(1);
  });

  it("is 2 for longer queries (>7 chars)", () => {
    expect(fuzzyThreshold(8)).toBe(2);
    expect(fuzzyThreshold(20)).toBe(2);
  });
});
