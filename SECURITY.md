# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately through GitHub: open the repository's **Security** tab and
choose **Report a vulnerability**. Include:

- the affected route, server action or file
- steps to reproduce
- what an attacker could gain

This is a solo project with no bug bounty. Reports are acknowledged within five
business days, and fixes are credited in the advisory if you want credit.

## Current exposure

Nostavel runs against LiteAPI's **sandbox** only. It takes no real bookings and
no real payments. Card details are entered into LiteAPI's payment SDK
(LiteAPI is merchant of record) and never reach this application.

## In scope

- Authentication, sessions and account ownership checks
- The booking and payment flow (prebook, checkout, confirmation, cancellation)
- Server actions and API routes, including webhook and cron authentication
- Pricing integrity: paying a price you are not entitled to
- Exposure of secrets, supplier net pricing, or other guests' data

## Out of scope

- Vulnerabilities in third-party services (LiteAPI, Stripe, Neon, Resend, Google)
- Denial of service and volumetric attacks
- Social engineering, and findings that need a compromised device or account
- Missing hardening headers without a demonstrated impact

## Supported versions

Only the `main` branch is supported.

## Secrets

Secrets live in environment variables, never in the repository. `.env.example`
lists the names; real values go in `.env.local`, which git ignores. A pre-commit
guard (`scripts/git-guard.mjs`) and secret scanning block credentials from being
committed.
