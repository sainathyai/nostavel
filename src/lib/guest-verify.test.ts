import { describe, it, expect, beforeEach, vi } from "vitest";

beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", "test-secret-do-not-use-in-prod");
});

describe("guest-verify", () => {
  it("makeCode produces a zero-padded 6-digit string", async () => {
    const { makeCode } = await import("./guest-verify");
    for (let i = 0; i < 20; i++) {
      const code = makeCode();
      expect(code).toMatch(/^\d{6}$/);
    }
  });

  it("accepts the correct code for the matching email", async () => {
    const { createChallenge, checkChallenge } = await import("./guest-verify");
    const token = await createChallenge("guest@example.com", "123456");
    const result = await checkChallenge(token, "guest@example.com", "123456");
    expect(result).toEqual({ ok: true, email: "guest@example.com" });
  });

  it("rejects a wrong code and bumps the attempt counter", async () => {
    const { createChallenge, checkChallenge } = await import("./guest-verify");
    const token = await createChallenge("guest@example.com", "123456");
    const result = await checkChallenge(token, "guest@example.com", "000000");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("mismatch");
      expect(result.nextToken).toBeTruthy();
    }
  });

  it("rejects the correct code against a mismatched email", async () => {
    const { createChallenge, checkChallenge } = await import("./guest-verify");
    const token = await createChallenge("guest@example.com", "123456");
    const result = await checkChallenge(token, "someone-else@example.com", "123456");
    expect(result.ok).toBe(false);
  });

  it("locks out after MAX_ATTEMPTS (5) wrong tries", async () => {
    const { createChallenge, checkChallenge } = await import("./guest-verify");
    let token = await createChallenge("guest@example.com", "123456");
    for (let i = 0; i < 5; i++) {
      const r = await checkChallenge(token, "guest@example.com", "000000");
      if (!r.ok && r.nextToken) token = r.nextToken;
    }
    const finalTry = await checkChallenge(token, "guest@example.com", "123456");
    expect(finalTry).toEqual({ ok: false, reason: "locked" });
  });

  it("expires after the challenge TTL", async () => {
    vi.useFakeTimers();
    try {
      const { createChallenge, checkChallenge, CHALLENGE_TTL_SEC } = await import(
        "./guest-verify"
      );
      const token = await createChallenge("guest@example.com", "123456");
      vi.advanceTimersByTime((CHALLENGE_TTL_SEC + 1) * 1000);
      const result = await checkChallenge(token, "guest@example.com", "123456");
      expect(result).toEqual({ ok: false, reason: "expired" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a missing/undefined token", async () => {
    const { checkChallenge } = await import("./guest-verify");
    const result = await checkChallenge(undefined, "guest@example.com", "123456");
    expect(result).toEqual({ ok: false, reason: "none" });
  });

  it("rejects a tampered token (signature mismatch)", async () => {
    const { createChallenge, checkChallenge } = await import("./guest-verify");
    const token = await createChallenge("guest@example.com", "123456");
    const [body] = token.split(".");
    const tampered = `${body}.forged-signature`;
    const result = await checkChallenge(tampered, "guest@example.com", "123456");
    expect(result).toEqual({ ok: false, reason: "none" });
  });

  it("round-trips a verified session and reports the email back", async () => {
    const { createVerifiedSession, readVerifiedEmail } = await import("./guest-verify");
    const token = await createVerifiedSession("guest@example.com");
    const email = await readVerifiedEmail(token);
    expect(email).toBe("guest@example.com");
  });

  it("readVerifiedEmail returns null once the verified session expires", async () => {
    vi.useFakeTimers();
    try {
      const { createVerifiedSession, readVerifiedEmail, VERIFIED_TTL_SEC } = await import(
        "./guest-verify"
      );
      const token = await createVerifiedSession("guest@example.com");
      vi.advanceTimersByTime((VERIFIED_TTL_SEC + 1) * 1000);
      expect(await readVerifiedEmail(token)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("readVerifiedEmail returns null for a missing token", async () => {
    const { readVerifiedEmail } = await import("./guest-verify");
    expect(await readVerifiedEmail(undefined)).toBeNull();
  });
});
