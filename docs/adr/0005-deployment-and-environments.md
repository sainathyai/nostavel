# ADR 0005: Deployment, environments, and what a shared copy refuses to do

- **Status:** accepted
- **Date:** 2026-10-06
- **Ticket:** [NOS-59](https://syrav.atlassian.net/browse/NOS-59) (epic), NOS-60, NOS-61
- **Deciders:** owner (decisions D-5.1 to D-5.5); orchestrator proposed, security-architect and code-reviewer reviewed

## Context

This app has only ever run on one laptop, where the person who configured it was also the
person using it. Three things follow from that, and all three now cost something:

1. **The owner cannot accept a change by using it.** Acceptance is reading a diff. In the
   two weeks before this ADR, two CRITICAL defects reached a pull request with every
   automated check green; both lived in a branch of a page that no test tier here can
   exercise, and both would have been obvious in half a minute of using the app. One of
   them would have shown every paying guest a failure page.
2. **The money-safety jobs are switched off.** The abandoned-hold sweeper and the nightly
   reconciler are written, tested and `disabled_manually`, because a scheduled workflow has
   nothing to call. The sweeper is the only thing that rescues a guest who was charged and
   whose browser never came back (NOS-5), so this is a gap in guest-money protection, not
   in convenience.
3. **Whole classes of defect are invisible.** The supplier's webhooks have never been
   received. Transactional email only delivers to the owner's own address until a sending
   domain is verified (NOS-12). `docs/production-readiness.md` §5 has had "no health check
   endpoint" on it since the audit.

Constraints: one human owner; the supplier stays on its **sandbox** and the live-money gate
stays shut; the repository is **public**, so anything deployed is a URL strangers will find,
and fork pull requests must never receive a deployment credential.

## Options

| Option | Cost | Risk | Notes |
|---|---|---|---|
| Keep running on a laptop | $0 | the three problems above stay | Where we were |
| Google Cloud Run | ~$2-5/month | most setup work: image, registry, secret store, pipeline | Scales to zero; tooling already installed and authenticated; portable, since the unit of deployment is a container |
| Vercel Hobby | $0 | **terms**: Hobby is personal, non-commercial use only, and this is owned by an LLC | Fastest to a URL, and a preview deployment per pull request |
| Vercel Pro | $20/month | none material | The honest version of the option above. Four to ten times the cost of Cloud Run for a prototype with no revenue |
| Fly.io / Render | ~$0-5/month | another vendor to learn | No advantage over Cloud Run here, given the tooling already present |

## Decision

**Cloud Run, one shared environment, delivered on merge, with database changes held behind
the owner's approval.** The five decisions, as settled by the owner on 2026-10-06:

| | Decision | Why |
|---|---|---|
| D-5.1 | **Google Cloud Run** | $2-5/month against $20; Hobby's non-commercial clause is a real constraint for an LLC-owned project, not a technicality |
| D-5.2 | **One environment now.** A real-money production environment gets its own separate pipeline, later | There is nothing to protect yet: the supplier is on its sandbox and the live gate is shut. A promotion step between two sandbox environments would be ceremony |
| D-5.3 | **Its own database copy** | Test bookings and development bookings stop mixing, and a sweeper running every three minutes never acts on development rows |
| D-5.4 | **The pipeline applies database changes, but pauses for the owner's approval first** — and only when there is something to apply | A migration was once run by hand against the wrong database (segment 3.2). Automating it without a gate repeats that faster; gating every merge trains the owner to click through without reading |
| D-5.5 | **One-off account setup by hand, written into a runbook; the running service defined in code** | Recreating a clicked-together service later is worse than writing it once, but the fiddliest part (bootstrap, federated identity) is a one-time cost that a runbook captures better than a module |

### What a shared copy refuses to do (NOS-60)

A deployed copy is configured by someone who is not watching it start, and the consequences
of a mistake are paid by a guest. Two checks therefore live in the app rather than in a
habit:

- **A live supplier key is fatal.** The probe scripts in `analysis/` already refuse to run
  without a `sand_` prefix; the app had no equivalent and would have taken real bookings
  with real money. This is the narrow version of the live-money gate, not the gate itself:
  no caps, no allowlist, no acknowledgement, no kill switch. Those remain a later segment,
  and this must not be mistaken for them.
- **A missing secret is fatal**, so a shared copy refuses every request rather than failing
  in the middle of a guest's booking. (Not "fails at startup": see *Where the refusal lives*
  below. An earlier draft of this ADR said startup in one place and per-request in another,
  which the NOS-60 security review flagged as the sentence that would be quoted back at
  someone.) `APP_URL` is in that list because `src/lib/email.ts` falls back to
  `http://localhost:3000`, which is right on a laptop and silently wrong everywhere else:
  every link mailed to a guest would be dead, with nothing erroring.

`APP_ENV` unset means a laptop, and every check above is skipped there, so `npm run dev`,
`npm test` and the browser smoke suite behave exactly as before. Two things are fatal
anyway: a live supplier key, because there is no environment in which this code should be
pointed at real money; and a built image that has not said which environment it is.

**That second one is D-60.1, and both review gates found it independently.** `APP_ENV` is
the single value whose absence switches off the password gate and every required-secret
check. Nothing in the repository set it, and the only copy of it was going to live in a
service definition created by a different ticket - so the image's default was "laptop".
Dropped once, by a rolled-back revision or a runbook followed with one block pasted short,
a copy would have come up as a public ungated booking app, mailed every guest a localhost
link, and left the abandoned-hold sweeper answering 401 forever (no `CRON_SECRET`
required), while the health route reported `ok: true, env: "local"`. The one
misconfiguration that disables the gate also disables the money-safety job this deployment
exists to switch on.

Both proposed fixes are taken, because each closes a case the other misses:

| | Fix | Closes |
|---|---|---|
| A | `ENV APP_ENV=unconfigured` in the image's runtime stage | The image defaults to refusing. The platform overrides it with the real name |
| B | A built image (`APP_SHA` present) with no `APP_ENV` is fatal | `APP_ENV=""` set explicitly, which overrides A and would otherwise read as a laptop |

The alternative - requiring the pipeline to assert `env === "uat"` before promoting - was
rejected as the only control: it puts the check in the artifact this repository tests least,
and "the pipeline will set it" is precisely the assumption that made the omission silent.

### The gate in front of a shared copy

**HTTP Basic, one password, any username.** The repository is public, so a deployed URL is a
URL strangers will find, and every natural-language search on it spends the owner's AI
credit while every booking attempt consumes sandbox quota and writes rows into the ledger
the owner is trying to accept a change in.

Basic was chosen over a styled password page deliberately: it needs no page, no form, no
cookie, no session and no CSRF question, in a change that sits directly in front of the
money path. It is a lock on a test environment, not a product surface.

**Three paths are exempt from the password and only from the password:** the health route
(the pipeline must be able to ask a broken copy what is wrong with it), the supplier's
webhook receiver, and the scheduled jobs. The last two already authenticate with a shared
secret compared in constant time, and locking them out would have silently switched off
guest-money recovery — the exact thing this deployment exists to enable. None of the three
is exempt from the configuration check.

**They are named one at a time, not matched by prefix.** The first draft exempted
`/api/cron/` and `/api/webhooks/` wholesale, which exempts every path that will ever exist
beneath them. The security review's scenario: a later `/api/cron/warm-search`, added to keep
the environment responsive and written without a bearer check because "it isn't money",
becomes an unauthenticated supplier-and-AI-spending endpoint on a gated environment, with no
failing test anywhere. An exact list makes the fourth path a decision someone has to make,
and getting it wrong fails closed and loudly: the scheduler gets a 401 it did not expect,
rather than the world getting a route it should not have.

What is excluded from the proxy's `matcher` is excluded from the live-key refusal as well as
from the password, so that list is a money decision too. `_next/static/` keeps its trailing
slash for that reason: Next's own documented example omits it, and without it the exclusion
is an unanchored prefix — `/_next/staticXYZ` was measured reaching the router with no gate
at all.

### Where the refusal lives, and where it does not

The refusal is enforced **per request** (`src/proxy.ts`), not at startup. It was written at
startup first, and measured against the real image: Next does not exit on a throw from the
instrumentation hook. It logs `Failed to prepare server`, keeps listening, and answers an
empty `500` to every path **including the health route** — so the one route built to explain
a broken deploy explained nothing, and the container still looked started to the platform.

A refusal that degrades the diagnosis is not a safety feature. Per-request is also strictly
stronger where it counts: a request that is never served cannot charge a card, whether or
not the process managed to start.

**And per-request was not enough on its own either.** The code review pointed out that this
was the *only* place the live-key rule was enforced, while every other credential in the app
is checked twice - the webhook secret by the proxy's exemption and again inside the webhook
route, `CRON_SECRET` likewise inside the sweeper and the reconciler. The rule described as
having zero tolerance was the one with no second check, and the failure class it named has a
CVE to its name (CVE-2025-29927, where a header skipped middleware entirely on self-hosted
Next). So the supplier client refuses too (`requireSandboxKey`), at the point where money
actually moves. When the live-money gate is eventually built, that function is what it has
to open deliberately, which means it cannot be opened by forgetting something.

One correction that came out of the same review: a process whose supplier key is corrected
in place **does** need a restart, because the supplier client captures the key at module
load and memoises the payment account derived from it. The gate re-reads per request; the
client does not.

## Consequences

- **Good:** the owner can accept a change by using it. The sweeper and the reconciler can be
  switched on, which closes a live gap in guest-money protection. Webhooks can be received
  for the first time. A live supplier key can no longer reach a guest-facing page by
  accident, in any environment.
- **Good:** the deployable unit is a container, so D-5.1 is reversible. Moving host means a
  new pipeline, not a new application.
- **Costs:** roughly $2-5 a month, plus the AI and supplier usage the environment generates.
  More setup than a one-vendor option, and a password to share with anyone who should see it.
- **Costs:** one more thing that can be misconfigured. The mitigation is that
  misconfiguration is now loud: the startup log names every problem, the health route
  reports them behind the operations secret, and the pipeline refuses to move traffic.
- **Deliberately not solved here:** error tracking, structured logging and request ids
  (`docs/production-readiness.md` §5); a custom domain; a verified email sending domain
  (NOS-12); the full live-money gate.
- **Follow-up work:** NOS-61 (the pipeline, the account setup, the runbooks, switching the
  scheduled jobs back on).

## Revisit when

- The live-money gate is ready to be considered, which is when the production environment and
  its separate pipeline get designed (D-5.2). That is also the moment to re-ask whether one
  password in front of a shared environment is still the right lock.
- The monthly bill leaves the $2-5 band, or the environment's AI and supplier usage stops
  being incidental.
- A second person needs to use the environment regularly, at which point a shared password
  stops being accountable and sign-in should carry the access decision instead.
