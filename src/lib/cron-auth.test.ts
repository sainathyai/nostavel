// The COMPOSITION of the cron gate (NOS-65). `cron-identity.test.ts` proves the
// rule; this file proves the rule is actually consulted.
//
// WHY THIS FILE EXISTS, IN ONE SENTENCE FROM THE SECURITY REVIEW: without it,
// deleting the `verifyCronCaller` call from `authorizeCronRequest` leaves 21 green
// tests, a clean typecheck and a clean lint, while authorising every Google Cloud
// customer to expire holds and drive supplier calls. jose alone checks the
// signature, `iss` and `aud`, and anyone can mint a Google-signed token for any
// audience, because our service is public and so Cloud Run does not validate the
// token for us.
//
// Every token below is signed by a key pair generated in this file. Nothing
// reaches Google, and no real credential exists anywhere in here.
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, type JWK } from "jose";
import { authorizeCronRequest } from "./cron-auth";

const EMAIL = "nostavel-uat-sweep-invoker@example-project.iam.gserviceaccount.com";
const SUB = "109876543210987654321";
const APP_URL = "https://nostavel-uat.example.com";
const AUDIENCE = `${APP_URL}/api/cron/sweep`;

const NOW = new Date("2026-10-14T12:00:00.000Z");
const nowSeconds = Math.floor(NOW.getTime() / 1000);

let ourKey: CryptoKey;
let ourJwk: JWK;
let otherKey: CryptoKey;
let keys: ReturnType<typeof createLocalJWKSet>;

beforeEach(async () => {
  const ours = await generateKeyPair("RS256", { extractable: true });
  const theirs = await generateKeyPair("RS256", { extractable: true });
  ourKey = ours.privateKey;
  otherKey = theirs.privateKey;
  ourJwk = { ...(await exportJWK(ours.publicKey)), alg: "RS256", kid: "test-key" };
  // Stands in for Google's published key set. Only OUR public key is in it, so a
  // token signed by `otherKey` has no resolvable key, exactly as a forged token
  // would not resolve against Google's.
  keys = createLocalJWKSet({ keys: [ourJwk] });

  process.env.CRON_SWEEP_INVOKER_EMAIL = EMAIL;
  process.env.CRON_SWEEP_INVOKER_SUB = SUB;
  process.env.APP_URL = APP_URL;
  // Assembled at runtime so no literal that looks like a credential is in this
  // file (conventions §6 / the tests rule).
  process.env.CRON_SECRET = "test-cron-" + Math.random().toString(36).slice(2);
});

afterEach(() => {
  delete process.env.CRON_SWEEP_INVOKER_EMAIL;
  delete process.env.CRON_SWEEP_INVOKER_SUB;
  delete process.env.CRON_SECRET;
});

async function token(
  claims: Record<string, unknown> = {},
  signWith: CryptoKey = ourKey,
  omit: string[] = [],
): Promise<string> {
  const payload: Record<string, unknown> = {
    email: EMAIL,
    email_verified: true,
    sub: SUB,
    ...claims,
  };
  for (const k of omit) delete payload[k];
  let jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer("https://accounts.google.com")
    .setAudience(AUDIENCE);
  if (!omit.includes("iat")) jwt = jwt.setIssuedAt(nowSeconds - 30);
  if (!omit.includes("exp")) jwt = jwt.setExpirationTime(nowSeconds + 3570);
  return jwt.sign(signWith);
}

function requestWith(bearer: string): Request {
  return new Request("https://nostavel-uat.example.com/api/cron/sweep", {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}` },
  });
}

const authorize = (bearer: string) =>
  authorizeCronRequest(requestWith(bearer), "sweep", NOW, keys);

describe("the OIDC path", () => {
  it("authorises a correctly signed token from the expected service account", async () => {
    expect(await authorize(await token())).toEqual({ ok: true, via: "oidc" });
  });

  it("refuses a token signed by a different key", async () => {
    // Proves the signature is load-bearing and not merely present.
    const result = await authorize(await token({}, otherKey));
    expect(result.ok).toBe(false);
  });

  it("REFUSES A CORRECTLY SIGNED TOKEN FROM SOMEONE ELSE'S SERVICE ACCOUNT", async () => {
    // THE TEST THE WHOLE FILE IS FOR. This is the one that goes red if
    // `verifyCronCaller` is ever dropped from the composition. The token below is
    // perfectly valid: real signature, right issuer, right audience, unexpired.
    // Only the caller's identity is wrong. jose accepts it; the rule must not.
    const result = await authorize(
      await token({ email: "attacker@some-other-project.iam.gserviceaccount.com" }),
    );
    expect(result).toEqual({ ok: false, reason: "email is not the expected caller" });
  });

  it("REFUSES THE TOKEN AN ATTACKER WOULD ACTUALLY HAVE: their own account, no email", async () => {
    // Now that `email` is optional, this is the realistic forgery rather than the
    // earlier one. Someone with any Google Cloud project mints a token for our
    // audience using THEIR service account. It is correctly signed by Google, the
    // issuer and audience are right, it is unexpired, and it carries no email at
    // all. Only `sub` tells it apart, which is why `sub` is the gate.
    const jwt = await token({ sub: "777777777777777777777" }, ourKey, ["email", "email_verified"]);
    expect(await authorize(jwt)).toEqual({ ok: false, reason: "sub is not the expected caller" });
  });

  it("refuses the right email with a different subject", async () => {
    const result = await authorize(await token({ sub: "999999" }));
    expect(result).toEqual({ ok: false, reason: "sub is not the expected caller" });
  });

  it("refuses an unverified email even when everything else is right", async () => {
    const result = await authorize(await token({ email_verified: false }));
    expect(result).toEqual({ ok: false, reason: "email_verified is not true" });
  });

  it("AUTHORISES A REAL SCHEDULER-SHAPED TOKEN, WHICH CARRIES NO EMAIL", async () => {
    // End to end through jose as well as the rule, because `requiredClaims`
    // listed `email` and `email_verified` and would have rejected this before the
    // rule was ever consulted. This is the token Cloud Scheduler actually sends.
    const jwt = await token({}, ourKey, ["email", "email_verified"]);
    expect(await authorize(jwt)).toEqual({ ok: true, via: "oidc" });
  });

  it("refuses a validly signed token with no expiry", async () => {
    // jose SKIPS its expiry check when `exp` is absent, so without
    // `requiredClaims` plus the rule's finiteness check, a Google-signed token
    // that never expires would be accepted forever.
    const result = await authorize(await token({}, ourKey, ["exp"]));
    expect(result.ok).toBe(false);
  });

  it("refuses a token minted for the other cron route", async () => {
    const jwt = await new SignJWT({ email: EMAIL, email_verified: true, sub: SUB })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer("https://accounts.google.com")
      .setAudience(`${APP_URL}/api/cron/reconcile`)
      .setIssuedAt(nowSeconds - 30)
      .setExpirationTime(nowSeconds + 3570)
      .sign(ourKey);
    expect((await authorize(jwt)).ok).toBe(false);
  });

  it("judges expiry against the injected clock, not the real one", async () => {
    // Before the M1 fix, jose used its own `new Date()` with zero tolerance, so
    // this assertion could not have held: a token from a fixed past instant would
    // always read as expired.
    const result = await authorize(await token());
    expect(result.ok).toBe(true);
    const later = await authorizeCronRequest(
      requestWith(await token()),
      "sweep",
      new Date(NOW.getTime() + 24 * 3600_000),
      keys,
    );
    expect(later.ok).toBe(false);
  });
});

describe("path selection cannot be gamed", () => {
  it("never falls through to the shared secret when a JWT is presented", async () => {
    // THE M2 FINDING. The first version only entered the OIDC branch when the
    // identity was configured, so with it unconfigured a JWT-shaped credential
    // was compared against CRON_SECRET. Not exploitable, but it made the stated
    // invariant false, and a claimed invariant that does not hold is how the next
    // person reasons wrongly about this file.
    delete process.env.CRON_SWEEP_INVOKER_SUB;
    const result = await authorize(await token());
    expect(result).toEqual({ ok: false, reason: "identity is not configured" });
  });

  it("refuses an HS256 token signed with the shared secret's own value", async () => {
    // Pins the cross-credential case. Closed today by jose's key resolver
    // refusing a secret-based algorithm, and by `algorithms: ["RS256"]`.
    const secret = new TextEncoder().encode(process.env.CRON_SECRET);
    const jwt = await new SignJWT({ email: EMAIL, email_verified: true, sub: SUB })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("https://accounts.google.com")
      .setAudience(AUDIENCE)
      .setIssuedAt(nowSeconds - 30)
      .setExpirationTime(nowSeconds + 3570)
      .sign(secret);
    expect((await authorize(jwt)).ok).toBe(false);
  });

  it("refuses a partial identity configuration rather than authorising", async () => {
    delete process.env.CRON_SWEEP_INVOKER_EMAIL;
    const result = await authorize(await token());
    expect(result).toEqual({ ok: false, reason: "identity is not configured" });
  });
});

describe("the legacy shared-secret path, which part 3 removes", () => {
  it("authorises the correct secret and says which credential it was", async () => {
    const result = await authorize(process.env.CRON_SECRET!);
    expect(result).toEqual({ ok: true, via: "shared-secret" });
  });

  it("refuses a wrong secret", async () => {
    expect((await authorize("test-cron-wrong-value")).ok).toBe(false);
  });

  it("refuses everything when CRON_SECRET is unset", async () => {
    const secret = process.env.CRON_SECRET!;
    delete process.env.CRON_SECRET;
    expect((await authorize(secret)).ok).toBe(false);
    expect((await authorize("")).ok).toBe(false);
  });

  it("refuses a request with no authorization header", async () => {
    const request = new Request(AUDIENCE, { method: "POST" });
    const result = await authorizeCronRequest(request, "sweep", NOW, keys);
    expect(result).toEqual({ ok: false, reason: "no authorization header" });
  });

  it("accepts a bare credential with no Bearer prefix, as the old route did", async () => {
    const request = new Request(AUDIENCE, {
      method: "POST",
      headers: { authorization: process.env.CRON_SECRET! },
    });
    expect((await authorizeCronRequest(request, "sweep", NOW, keys)).ok).toBe(true);
  });
});
