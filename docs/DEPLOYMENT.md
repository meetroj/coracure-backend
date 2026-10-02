# Deploying to AWS

One container, one image, on EC2. Everything the service needs at runtime is an
environment variable, so the same image runs locally, on staging and in
production.

## What the service expects from AWS

| Concern          | AWS piece                   | What the code already does                                                                                                                                                       |
| ---------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TLS              | nginx on the instance       | `TRUST_PROXY=true` makes Fastify read `X-Forwarded-For`, so the IP in `audit_log` and on a `consents` row is the real client's                                                   |
| Health           | nginx + external monitor    | `GET /api/v1/health` for liveness, `/api/v1/health/ready` for readiness. Monitor the **ready** path from outside the box                                                                                        |
| Database         | RDS PostgreSQL 17           | `DATABASE_URL` with `?sslmode=require`. Pool size is `DATABASE_POOL_MAX`                                                                                                         |
| Cache and queues | Not used yet                | `REDIS_URL` is **optional** and nothing in `src` opens a connection. Provision one only when something reads it, or for a multi-node LiveKit cluster|
| Logs             | CloudWatch                  | Pino writes JSON to stdout. Use the `awslogs` Docker log driver; the app writes no log files                                                                                     |
| Secrets          | SSM Parameter Store         | Injected as environment variables at start. Nothing secret is ever read from `app_config`                                                                                        |
| Object storage   | S3                          | `STORAGE_PROVIDER=s3` plus `AWS_S3_BUCKET` and `AWS_REGION`, from M-05 onward. Uploads and downloads are signed URLs the client uses directly, so bytes never cross this service |

## TLS and health checks

**There is no load balancer.** nginx runs on the instance, terminates TLS and
reverse-proxies to the container on `127.0.0.1:3000`. The config is version
controlled at `deploy/nginx/coracure.conf`; certificates come from Let's Encrypt
via certbot. See `CICD.md` for the installed state and the certbot command.

Two consequences of having no ALB, both of which matter:

- **The container must publish on `127.0.0.1:3000`, never `0.0.0.0:3000`.** Published on all interfaces it would answer in clear text and bypass every header nginx sets — including the `X-Forwarded-For` that `TRUST_PROXY` makes Fastify believe and the audit log records as the client.
- **A deploy is a brief outage.** Nothing drains connections on one host. `docker stop --time 30` must exceed the longest in-flight request; beyond that, a restart drops whoever was mid-call. A second instance behind a real load balancer is the only fix, and it is not worth it yet.

Monitor `/api/v1/health/ready` from outside the box. It runs `SELECT 1`, so it
reports a service that has lost its database. `/api/v1/health` checks nothing
and is for liveness only — a container with a dead database passes it happily.

## Graceful shutdown

The container runs `node dist/main.js` directly, **not** `npm start`. npm does
not forward `SIGTERM` to its child, so under npm the process would be killed
outright and the load balancer would see connections cut mid-request instead of
drained. `app.enableShutdownHooks()` catches `SIGTERM`, stops accepting new
connections, finishes in-flight requests and closes the database pool.

Keep the ALB deregistration delay longer than the time a request may take, and
`docker stop`'s grace period (`--time`, default 10s) longer again.

## Environment

Copy `.env.example`. In AWS these come from the task definition or SSM, never a
`.env` file baked into the image — `.dockerignore` excludes `.env` for exactly
that reason.

Production-only checks the app enforces at boot, before serving anything:

- `OTP_PROVIDER` must be `slide`. The `stub` provider accepts one fixed code,
  and shipping it would make every account signable-into.
- `SLIDE_API_KEY` must be set whenever `OTP_PROVIDER=slide`.
- `STORAGE_PROVIDER` must be `s3`. The `stub` provider signs URLs that go
  nowhere, so doctor credentials would appear to upload and be stored nowhere.
- `AWS_S3_BUCKET` must be set whenever `STORAGE_PROVIDER=s3`. Credentials
  themselves are optional: with none set, the SDK uses the task or instance
  role, which is how this should run.
- `JWT_ACCESS_SECRET` must be at least 32 characters.
- `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` must both be set, must not be the
  committed `devkey` pair, and `LIVEKIT_URL` must be `wss://`. Without the
  credentials no consultation can be joined and no session is recorded; over
  `ws://` the join token — a bearer credential for a clinical call — would go
  in clear text.

A bad environment fails the boot with every problem listed at once, so a
misconfigured deploy never half-starts.

## Build and run

```bash
docker build -t coracure-api:$(git rev-parse --short HEAD) .

docker run --rm -p 3000:3000 --env-file .env coracure-api:<tag>
```

The image is multi-stage: the build stage installs, generates the Prisma client
and compiles, then strips dev dependencies with `npm prune --omit=dev`; the
runtime stage copies that pruned tree, `dist` and `prisma/`. It runs as the
unprivileged `node` user.

Three packaging decisions worth knowing, because each was forced by something
that actually broke:

- **npm 11 is installed into the build stage.** `node:22` ships npm 10, which
  refuses this lock file — it reports transitive dev packages (`chokidar`,
  `readdirp`) missing, because npm 11 records their nesting differently.
  `engines.npm` in `package.json` records the requirement.
- **`npm prune --omit=dev`, not a second `npm ci --omit=dev` stage.** Pruning
  operates on the tree that was just built and tested, so the two cannot
  disagree, and it does not re-resolve the lock file. It also leaves the
  generated Prisma client where it already is.
- **The Prisma CLI and `tsx` are runtime dependencies, not dev ones.** The
  release applies migrations by running `npm run db:migrate` inside this image,
  and bootstraps the first admin with `npm run db:seed`, which is a TypeScript
  file `tsx` executes. `npm prune --omit=dev` would take either away, and the
  failure only shows up on a deployed container - `sh: 1: tsx: not found`,
  after the image is already built, pushed and running.

Debian slim rather than Alpine on purpose — `argon2` is a native module with
prebuilt glibc binaries; on musl it has to be compiled in the image, which
means shipping a toolchain.

## Release order

Migrations are forward-only and are applied from the same image that is about
to serve, so the schema and the code can never disagree:

```bash
# 1. Apply migrations (one task, not every instance)
docker run --rm --env-file .env coracure-api:<tag> npm run db:migrate

# 2. Roll the service to the new image

# 3. First environment only - bootstrap admin and legal copy
docker run --rm --env-file .env \
  -e ADMIN_EMAIL=you@coracure.in -e ADMIN_PASSWORD='<12+ chars>' \
  coracure-api:<tag> npm run db:seed
```

`db:seed` is idempotent. It never overwrites an existing admin password and
never replaces legal copy that is already published, so it is safe to leave in
a pipeline.

> The seeded legal documents are **placeholders**, published as version `0.0`.
> SRS section 8 makes all legal and clinical wording the client's to author and
> approve. Publishing the real text as `1.0` supersedes the placeholder and
> keeps it as history — no row is ever edited.

## Scaling notes

- The service holds no session state. Revocation is a `token_version` column,
  so any instance can serve any request and there is nothing sticky to route.
- `app_config` values are cached per instance for `APP_CONFIG_CACHE_TTL_MS`
  (default 30s), so an admin's change reaches every instance within that
  window. There is no cache invalidation channel; lower the TTL if that matters
  more than the query count.
- Sign-in rate limits are counted from `audit_log`, which is shared, so they
  hold across instances and survive a restart. The per-IP `ThrottlerModule`
  ceiling is per instance and is only a blunt backstop.

## LiveKit (M-14)

LiveKit is a **separate deployment** from this service, not another container
beside it. The API is the control plane — it authorises joins and mints tokens;
LiveKit is the media plane and carries the WebRTC traffic. They scale on
different axes and fail independently: the API is perfectly healthy with LiveKit
down, it simply cannot start a call.

```
        Internet
            |
  +---------+-----------+
  |                     |
  v                     v
Coracure API      livekit.<domain>
  |                     |
  |                     v
  |                   Caddy  (TLS terminates here, never in LiveKit)
  |                     |
  v                     v
PostgreSQL          LiveKit :7880
```

Media never passes through the API, and never through Redis. Redis coordinates
a **cluster** of LiveKit nodes; it is not in the media path, and a single node
does not need it. Start with one node.

### What the EC2 instance needs

Current Ubuntu LTS, Docker, and the official LiveKit VM deployment (its
generator produces the Caddy and compose configuration — do not hand-write an
unsupported one). Size it by benchmarking real load: LiveKit's capacity depends
on participants, rooms, resolution, bitrate and publish/subscribe pattern, and
no instance type is universally right.

- **Public reachability.** An Elastic IP, a DNS record for `livekit.<domain>`,
  and `rtc.use_external_ip: true` — EC2 binds a private interface while clients
  reach a public address, and WebRTC must advertise the reachable one. This is
  the single most common cause of a call that connects and then carries no
  media; verify it explicitly.
- **Security group.** 80 and 443/TCP for Caddy, 7881/TCP for the WebRTC TCP
  fallback, and the UDP media range (50000–60000 as one rule, not the twenty
  ports compose forwards locally). TURN ports as configured. SSH restricted.
- **TLS.** Caddy terminates it and reverse-proxies to LiveKit on 7880. The
  client endpoint is `wss://livekit.<domain>`; an insecure endpoint would carry
  join tokens in clear text and browsers refuse a `ws://` socket from an https
  page anyway.
- **TURN.** Required for clients whose network passes no direct UDP path at all.
  Test it from a genuinely restrictive network — a corporate guest wifi or a
  locked-down mobile connection — not from the same LAN, where it never engages.
- **The webhook URL** in `livekit.yaml` must point at this service's public
  `https://.../api/v1/video/webhook`. Without it no session metadata is ever
  recorded, and no call moves the consultation to `in_progress`. LiveKit signs
  those with the same key pair used for tokens; there is no separate secret.

### What changes in this codebase

Only configuration. `LIVEKIT_URL` becomes `wss://livekit.<domain>`, and the key
pair becomes a generated production one from SSM. The token service, the room
naming and the webhook handling are identical against a local container and
against AWS, which is deliberate — the local architecture is the production one
with different values.

### Not deployed, on purpose

- **Egress/recording.** Nothing is recorded (FR-8.6), so there is no recorder,
  no bucket and no retention policy to write.
- **Redis, multiple nodes, a load balancer, EKS.** None until a single node is
  stable and a measured workload asks for more.
