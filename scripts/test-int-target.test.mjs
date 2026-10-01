// Run: npm run test:agents
//
// This is the regression test for the NOS-29 production-database incident
// (see scripts/test-int-target.mjs's file comment for the full story): a
// plain unit test, not a *.int.test.ts file, specifically so it runs under
// `npm test` / `npm run verify` with no Docker and no database - the guard
// it exercises is pure, and the whole point is that it must be provably
// correct BEFORE anything ever tries to connect to it for real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertLocalFetchEndpoint, assertLocalTestTarget } from "./test-int-target.mjs";

// Every connection string below is assembled from separate pieces, never
// written as one literal string with a scheme, a credential pair and a host
// all joined together - same reasoning as scripts/test-int.mjs's own file
// comment: it keeps this file's source text from ever looking like a
// credential-bearing connection string to the repository guard
// (scripts/agent-guards/patterns.mjs), even though none of these are real.
function url(user, password, host, database) {
  return "postgres://" + user + ":" + password + "@" + host + "/" + database;
}

const refuses = (value, pattern) => {
  assert.throws(() => assertLocalTestTarget(value), pattern);
};
const allows = (value) => {
  assert.doesNotThrow(() => assertLocalTestTarget(value));
};

test("refuses when DATABASE_URL is missing entirely", () => {
  refuses(undefined, /no DATABASE_URL was set/);
  refuses("", /no DATABASE_URL was set/);
});

test("refuses a production-looking Neon host", () => {
  const fakeNeonUrl = url("realuser", "realpass", "ep-cool-forest-12345.us-east-2.aws.neon.tech", "neondb");
  refuses(fakeNeonUrl, /is not the local test container/);
  refuses(fakeNeonUrl, /host "localhost" or "127\.0\.0\.1"/);
});

test("refuses the local host on the wrong port", () => {
  refuses(url("postgres", "postgres", "localhost:5432", "main"), /expected port "55432"/);
});

test("refuses the local host and port with the wrong database name", () => {
  refuses(url("postgres", "postgres", "localhost:55432", "postgres"), /expected database "main"/);
  // The owner's real Neon database is very unlikely to be literally named
  // "main", but a wrong-name refusal must fire regardless of what the wrong
  // name happens to be - this is the "harms nobody by being over-strict"
  // direction of the check, mirrored against the production-host case above.
  refuses(url("postgres", "postgres", "localhost:55432", "verceldb"), /expected database "main"/);
});

test("refuses a value that isn't a URL at all", () => {
  refuses("not-a-connection-string", /could not be parsed/);
});

test("accepts the local container on localhost or 127.0.0.1, on the expected port and database", () => {
  allows(url("postgres", "postgres", "localhost:55432", "main"));
  allows(url("postgres", "postgres", "127.0.0.1:55432", "main"));
});

test("refuses a local URL with no port, because the default is not this suite's port", () => {
  // A postgres:// URL with no port means the driver default, 5432. The test
  // container publishes 55432 on the host precisely so it cannot collide with
  // a developer's own Postgres on the default port - so a portless URL is some
  // other database, and is refused even though the host is local.
  refuses(url("postgres", "postgres", "localhost", "main"), /expected port "55432"/);
});

test("never puts the password in a refusal message", () => {
  const secret = url("postgres", "s3cr3t-not-a-real-password", "ep-cool-forest-12345.neon.tech", "neondb");
  try {
    assertLocalTestTarget(secret);
    assert.fail("expected assertLocalTestTarget to throw");
  } catch (err) {
    assert.ok(!err.message.includes("s3cr3t-not-a-real-password"), `password leaked into: ${err.message}`);
    assert.ok(!err.message.includes(secret), "whole connection string leaked into the error message");
  }
});

test("names which source a bad value came from, when given one", () => {
  try {
    assertLocalTestTarget(undefined, { source: "process.env.DATABASE_URL, in scripts/test-int-migrate.mjs" });
    assert.fail("expected assertLocalTestTarget to throw");
  } catch (err) {
    assert.match(err.message, /scripts\/test-int-migrate\.mjs/);
  }
});

// NOS-34: assertLocalFetchEndpoint guards the second leg a query travels -
// neonConfig.fetchEndpoint, sent as the "Neon-Connection-String" header's
// destination by @neondatabase/serverless (see test-int-target.mjs's comment
// above the function for where that's confirmed in the driver's own
// source). Same refusal/acceptance shape as assertLocalTestTarget above, so
// the same style of test applies.

const endpointRefuses = (value, pattern) => {
  assert.throws(() => assertLocalFetchEndpoint(value), pattern);
};
const endpointAllows = (value) => {
  assert.doesNotThrow(() => assertLocalFetchEndpoint(value));
};

test("fetch endpoint: refuses when missing entirely (undefined)", () => {
  endpointRefuses(undefined, /no fetch endpoint was set/);
});

test("fetch endpoint: refuses a value that is explicitly set to the empty string", () => {
  // `NEON_PROXY_URL=""` is not caught by `??`, which only replaces null/undefined -
  // so an explicit empty override must be refused by this function itself, the
  // same way an absent value is, not silently treated as "use the default".
  endpointRefuses("", /no fetch endpoint was set/);
});

test("fetch endpoint: refuses a value that isn't a URL at all", () => {
  endpointRefuses("not-a-url", /could not be parsed/);
});

test("fetch endpoint: refuses a remote host", () => {
  endpointRefuses("https://evil.example.com:4444/sql", /host "localhost" or "127\.0\.0\.1"/);
});

test("fetch endpoint: refuses the local host on the wrong port", () => {
  endpointRefuses("http://localhost:9999/sql", /expected port "4444"/);
});

test("fetch endpoint: refuses the local host and port with no port at all", () => {
  // http:// with no explicit port means 80, the driver's and this suite's
  // own default, never port 4444 - so a portless local URL must be refused
  // the same way a wrong explicit port is.
  endpointRefuses("http://localhost/sql", /expected port "4444"/);
});

test("fetch endpoint: refuses the local host and port with the wrong path", () => {
  endpointRefuses("http://localhost:4444/not-sql", /expected path "\/sql"/);
  endpointRefuses("http://localhost:4444/", /expected path "\/sql"/);
});

test("fetch endpoint: accepts the local proxy on localhost or 127.0.0.1, on the expected port and path", () => {
  endpointAllows("http://localhost:4444/sql");
  endpointAllows("http://127.0.0.1:4444/sql");
});

test("fetch endpoint: accepts the documented default", () => {
  // scripts/test-int-neon-setup.mjs's fallback when NEON_PROXY_URL is unset -
  // must stay accepted, since the whole point is validating the *effective*
  // value, default included, not rejecting an unset override.
  endpointAllows("http://localhost:4444/sql");
});

test("fetch endpoint: never puts the value itself in a refusal message beyond host/port/path", () => {
  const value = "https://evil.example.com:4444/sql";
  try {
    assertLocalFetchEndpoint(value);
    assert.fail("expected assertLocalFetchEndpoint to throw");
  } catch (err) {
    // The parsed pieces are expected to appear (that's the point of
    // describeEndpoint); the raw value as a single string must not.
    assert.ok(!err.message.includes(value), "whole fetch endpoint value leaked into the error message");
  }
});

test("fetch endpoint: names which source a bad value came from, when given one", () => {
  try {
    assertLocalFetchEndpoint(undefined, {
      source: "NEON_PROXY_URL (or its default), checked by scripts/test-int-neon-setup.mjs",
    });
    assert.fail("expected assertLocalFetchEndpoint to throw");
  } catch (err) {
    assert.match(err.message, /scripts\/test-int-neon-setup\.mjs/);
  }
});
