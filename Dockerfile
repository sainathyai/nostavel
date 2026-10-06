# The deployable image (NOS-60). Built by the delivery pipeline, and runnable by
# hand with `docker run` for a local check before anything reaches the cloud.
#
# Three stages so the thing that serves guests contains none of the things that
# built it: no source, no development dependencies, no build tools. Next's
# "standalone" output (next.config.ts) does the work - it traces exactly the
# files the server actually needs and writes a self-contained server.js.
#
# TWO DIRECTORIES STANDALONE DOES NOT INCLUDE, AND BOTH MATTER HERE:
#
#   - public/ holds the vendored MapLibre worker. A missing worker breaks the
#     map with no build error and no failing test - the same silent failure
#     `npm run vendored:check` exists to catch, which is why it is copied
#     explicitly below rather than left to the trace.
#   - .next/static holds every stylesheet and client bundle. Without it the app
#     serves unstyled HTML that works well enough to look deployed.
#
# BASE IMAGE PINNED BY DIGEST, not by tag, following compose.test.yml's rule for
# the same reason: a tag is a moving target, and "it worked yesterday" should
# mean the same bytes. Resolved 2026-10-06 for node:24-alpine via
# `docker image inspect node:24-alpine --format '{{index .RepoDigests 0}}'`
# after a fresh pull. Re-resolve and update this comment when it needs to move;
# do not just bump the tag.
FROM node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS base
# Alpine ships musl, and some of Next's prebuilt native binaries expect glibc
# symbols. This shim is what the Next project's own Dockerfile installs for the
# same reason.
RUN apk add --no-cache libc6-compat

# --- dependencies -----------------------------------------------------------
# Separate stage so a change to application source does not reinstall anything.
# Development dependencies are included on purpose: `next build` needs
# TypeScript, Tailwind and PostCSS, none of which reach the final stage.
#
# `npm ci` runs this repository's "prepare" script, which points git at
# .githooks/. That script has to be present for the install to succeed, which is
# why scripts/ is copied here as well - and it already handles not being a git
# checkout (scripts/git-guard.mjs §--install: "Not a git checkout (tarball
# install, Docker build): nothing to install"), which is also what happens here,
# since this image has no git binary at all. So no --ignore-scripts is needed
# and dependency install scripts still run exactly as they do in CI.
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci

# --- build ------------------------------------------------------------------
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEEDS NO SECRETS, and must keep needing none. The database client connects on
# first query rather than at import (src/db/index.ts), which is what lets CI
# build this on a fork pull request with no credentials. If a build ever starts
# needing a real value, that is a regression in that boundary, not a reason to
# pass one in here: a secret given to a build is a secret baked into a layer.
# .dockerignore excludes .env* so a developer's own file cannot be copied in by
# accident.
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# --- runtime ----------------------------------------------------------------
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Cloud Run sends requests to $PORT and will override this; 8080 is its default
# and makes `docker run -p 8080:8080` behave the same locally.
ENV PORT=8080
# Without this the standalone server binds loopback inside the container, which
# looks identical to a crash from the outside: the container starts, listens,
# and answers nothing.
ENV HOSTNAME=0.0.0.0

# Which commit this image is. Baked in at build time rather than passed at
# deploy time so the answer from /api/health cannot drift from the code that is
# actually running - the first question about any deployed copy is "which build
# is this". Not a secret: this repository is public.
ARG APP_SHA=unknown
ENV APP_SHA=$APP_SHA

# `node` (uid 1000) ships with the base image. Nothing here writes to disk, so
# the application owns none of its own files: a compromised process cannot
# rewrite the code it is running.
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

USER node
EXPOSE 8080

# The traced server, not `next start`: `next` itself is a development dependency
# and is deliberately not in this stage.
CMD ["node", "server.js"]
