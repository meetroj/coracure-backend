# Coracure API. Multi-stage so the image that runs on EC2 carries no compiler
# and no dev dependency. It does carry `src`, for the one reason given below.
#
# Debian slim rather than Alpine on purpose: `argon2` is a native module and
# ships prebuilt binaries for glibc. On musl it has to be compiled from source
# in the image, which needs a toolchain we would then be shipping.

# --- build -------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# node:22 ships npm 10, which cannot install this lock file - it is written by
# npm 11 and npm 10 reports transitive dev packages missing. Build with the npm
# the lock file was written by; `engines.npm` in package.json records which.
RUN npm install -g npm@11

# Dependencies first, so a source-only change reuses this layer.
COPY package*.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
# `postinstall` runs `prisma generate`, which needs the schema copied above.
RUN npm ci

COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build

# Strip the dev dependencies from the tree that was just installed, rather than
# resolving a second, production-only tree with `npm ci --omit=dev`. Two
# reasons: `prune` cannot disagree with what was built and tested, and it does
# not re-resolve the lock file - `npm ci --omit=dev` currently fails on this
# one, reporting chokidar missing because dev packages nest their own copies.
# It also leaves the generated Prisma client in place, so nothing is copied
# out of a second stage and hoped to match.
RUN npm prune --omit=dev

# --- runtime -----------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# curl is the container health check. `--no-install-recommends` keeps it small.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

# Pruned in the build stage, generated Prisma client included.
#
# `--chown=node:node` is NOT cosmetic. COPY lands files owned by root and the
# container runs as `node`; the Prisma CLI checks it can write to
# `node_modules/@prisma/engines` at startup and aborts with "please make sure
# you install prisma with the right permissions" when it cannot. That check is
# on the release path - `npm run db:migrate` runs inside this image - so
# without this the deploy fails at the migration step and never serves.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
# Migrations and the schema travel with the image, so `npm run db:migrate` on a
# deployed container applies exactly the migrations that image was built from.
COPY --from=build --chown=node:node /app/prisma ./prisma

# The seed is TypeScript and imports `hashPassword` from `src`, so `src` has to
# be here for `npm run db:seed` - the documented way to bootstrap the first
# admin and the legal copy - to resolve it. This amends the header above: the
# image does carry source, for this one reason.
#
# 2.1MB against a 766MB image, and the alternative was a second import path
# that only exists in production. tsx then resolves exactly as it does on a
# developer's machine, so the seed cannot behave differently in the two places.
COPY --from=build --chown=node:node /app/src ./src
COPY --chown=node:node package*.json prisma.config.ts ./

# The node image ships an unprivileged `node` user. Nothing here is written to
# at runtime - logs go to stdout for CloudWatch.
USER node

EXPOSE 3000

# The ALB has its own health check on this path; this one is for `docker ps`
# and for ECS, which will not route to a container it believes is unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/v1/health || exit 1

# Straight to node, with no npm wrapper: npm does not forward SIGTERM, so the
# graceful shutdown `enableShutdownHooks` sets up would never run and the load
# balancer would see connections cut rather than drained.
CMD ["node", "dist/main.js"]
