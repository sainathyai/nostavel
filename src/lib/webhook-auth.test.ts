import { describe, it, expect } from "vitest";
import { verifySharedSecret } from "./webhook-auth";

describe("verifySharedSecret", () => {
  it("accepts an exact match", () => {
    expect(verifySharedSecret("s3cret", "s3cret")).toBe(true);
  });

  it("rejects a wrong value", () => {
    expect(verifySharedSecret("wrong", "s3cret")).toBe(false);
  });

  it("rejects a different-length value without throwing", () => {
    // timingSafeEqual throws on length mismatch — the wrapper must guard it.
    expect(() => verifySharedSecret("short", "a-much-longer-secret")).not.toThrow();
    expect(verifySharedSecret("short", "a-much-longer-secret")).toBe(false);
  });

  it("rejects when either side is missing", () => {
    expect(verifySharedSecret(null, "s3cret")).toBe(false);
    expect(verifySharedSecret(undefined, "s3cret")).toBe(false);
    expect(verifySharedSecret("s3cret", undefined)).toBe(false);
    expect(verifySharedSecret("", "s3cret")).toBe(false);
  });
});
