# CI/CD

Pipeline for `github.com/coracure/coracure_backend`. Deployment targets and the
reasoning behind them are in `DEPLOYMENT.md`; this document is what the
pipeline does and what it needs configured.

---

## 1. What runs when

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| `ci.yml` | every pull request, and push to `main` | Lint, types, unit, e2e, migrations, image boot |
| `release.yml` | push to `main`, or manual dispatch | Verify, publish to ECR, deploy behind an approval |
| `dependabot.yml` | weekly | Grouped dependency updates |

### CI jobs

- **quality** — `lint`, `typecheck`, `test:coverage`. No database and no environment: only `main.ts` and `prisma.config.ts` load dotenv, and no spec imports either, so the unit suite is self-contained by construction.
- **e2e** — `test:e2e`. The one e2e spec boots a Fastify app with stubbed services to catch transport-layer faults that no unit test can see.
- **migrations** — Postgres 17 service, `db:migrate` on an empty database, then a **drift check** and a **double seed**.
- **image** — builds the Dockerfile, applies migrations *by running the image*, boots it, waits on `/api/v1/health/ready`, and then asserts the image **refuses** to boot with `NODE_ENV=production` and `OTP_PROVIDER=stub`.
- **audit** — `npm audit --audit-level=high`, advisory only.

**CodeQL was removed.** Code scanning needs GitHub Advanced Security, which a
private repository does not have by default, so the workflow failed on every
push and pull request and burned Actions minutes doing it. Re-add it if the
repository is made public, or if GHAS is purchased — the workflow was three
dozen lines and is in the history at `cc2d06f`.

Three of those deserve explanation.

**The drift check.** Migrations passing proves the migrations are applicable; it
does not prove they match `schema.prisma`. Someone editing the datamodel and
forgetting the migration produces a green suite and a broken deploy.
`prisma migrate diff --exit-code` between the migrated database and the
datamodel returns 2 when they differ, so that mistake fails here instead.

**The double seed.** `DEPLOYMENT.md` claims the seed is safe to leave in a
pipeline because it never overwrites an admin password and never replaces
published legal copy. Running it twice is what makes that a tested property
rather than a comment.

**The bad-configuration test.** M-01's completion criterion is that the service
"rejects a bad configuration". A production build running the stub OTP provider
would accept one fixed code for every account on the platform. A pipeline that
only exercised the happy path would ship that cheerfully, so the CI asserts the
boot fails.

---

## 2. Repository configuration

### Variables (Settings → Secrets and variables → Actions → Variables)

| Name | Example | Used by |
| --- | --- | --- |
| `AWS_REGION` | `ap-south-1` | publish, deploy |
| `ECR_REPOSITORY` | `coracure-api` | publish |
| `EC2_NAME_TAG` | `coracure-api-prod` | deploy — the `Name` tag SSM targets |
| `HEALTH_URL` | `https://api.coracure.in/api/v1/health/ready` | deploy verification |

Set these per environment (`staging`, `production`) rather than repository-wide,
so a staging deploy cannot reach production infrastructure.

### Secrets

| Name | Value |
| --- | --- |
| `AWS_DEPLOY_ROLE_ARN` | The IAM role GitHub assumes via OIDC |

**No long-lived AWS keys.** The workflows use GitHub's OIDC provider, so there
is no access key in the repository to leak or rotate. Set the role's trust
policy to this repository and, for production, to the `main` branch only:

```json
{
  "Effect": "Allow",
  "Principal": { "Federated": "arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com" },
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {
    "StringEquals": {
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
    },
    "StringLike": {
      "token.actions.githubusercontent.com:sub": "repo:coracure/coracure_backend:*"
    }
  }
}
```

Attach this as an inline policy. **The read actions are not optional:** buildx
checks for existing manifests and layers while pushing, so a push-only policy
fails at the very last step with `not authorized to perform: ecr:BatchGetImage`
after the layers have already uploaded.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EcrAuth",
      "Effect": "Allow",
      "Action": "ecr:GetAuthorizationToken",
      "Resource": "*"
    },
    {
      "Sid": "EcrPushAndPull",
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability",
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:PutImage",
        "ecr:DescribeRepositories",
        "ecr:DescribeImages"
      ],
      "Resource": "arn:aws:ecr:ap-south-1:563524961006:repository/coracure-api"
    },
    {
      "Sid": "DeployViaSsm",
      "Effect": "Allow",
      "Action": [
        "ssm:SendCommand",
        "ssm:GetCommandInvocation",
        "ssm:ListCommandInvocations"
      ],
      "Resource": "*"
    },
    {
      "Sid": "FindTheInstance",
      "Effect": "Allow",
      "Action": "ec2:DescribeInstances",
      "Resource": "*"
    }
  ]
}
```

`ssm:SendCommand` is left at `*` deliberately for now: it must authorise both
the instance ARN and the document ARN, and getting one of the two wrong fails
in a way that looks identical to the permission being absent. Tighten it to the
instance and `AWS-RunShellScript` once the pipeline is green.

#### The `sub` claim is not what you expect

This organisation has GitHub's **immutable subject claims** enabled, so the
`sub` carries numeric owner and repository IDs:

```
repo:coracure@326920660/coracure_backend@1362506164:ref:refs/heads/main
```

The obvious pattern `repo:coracure/coracure_backend:*` never matches it, while
the `repository` claim still reads `coracure/coracure_backend` — which makes
the trust policy look correct next to a failing run. Match on the ID form; it
also survives a rename, so it is the stronger condition anyway.

If OIDC ever fails with `Not authorized to perform sts:AssumeRoleWithWebIdentity`,
that is a TRUST failure, never a permissions one, and the fastest way to settle
it is to print the claims — the step that did so is in the history at `cc2d06f`.

### Environments

Create `staging` and `production` under Settings → Environments. Put **required
reviewers** on `production`. Without that, `environment:` in the workflow is
decoration and every merge to `main` reaches production unreviewed.

### TLS with nginx

There is no ALB. nginx terminates TLS on the instance and proxies to the
container on `127.0.0.1:3000`. The config is version controlled at
`deploy/nginx/coracure.conf` and installed at `/etc/nginx/conf.d/coracure.conf`.

Installed and verified on 9 September 2026:

- nginx 1.30.4 and certbot 2.6.0, both enabled and running.
- Port 80 answers the ACME challenge from `/var/www/certbot` and 301s everything else to HTTPS. The challenge location sits **above** the redirect — below it, certbot's validation gets redirected and renewal fails silently until the certificate expires.
- Port 443 serves a **self-signed placeholder** (`/etc/nginx/ssl/`, CN and SAN on the IP, valid to September 2027).
- The stock nginx welcome site was moved to `127.0.0.1:8080` so it cannot answer publicly and cannot collide with `default_server`.

Verified end to end: `http://` → 301, `https://` → 502 (correct — no container is
running yet), and `/.well-known/acme-challenge/` → 200 without a redirect.

#### Getting a real certificate

A self-signed certificate is **not usable by the mobile apps**. React Native
rejects an untrusted certificate outright, and LiveKit needs `wss://` on a real
name. Let's Encrypt will not issue for a bare IP address, so this needs a
domain:

1. Point an A record — say `api.coracure.in` — at `3.111.230.242`.
2. Open **80 and 443** in the security group. Only 22 is open today, so nothing here is reachable from the internet yet, and HTTP-01 validation needs 80.
3. Then, on the box:

```bash
sudo certbot --nginx -d api.coracure.in --agree-tos -m ops@coracure.in --redirect
```

certbot rewrites the `ssl_certificate` lines in place and installs a renewal
timer. Set `server_name` to the real name at the same time — it is `_` today
because there is no domain to name.

### Live state, verified 10 September 2026

The pipeline is complete and the API is deployed. Verified end to end: an admin
sign-in posted to `https://.../api/v1/auth/admin/sign-in` returned **HTTP 200**
with real tokens, which exercises nginx TLS termination, the proxy, routing and
validation, Postgres, argon2 verification and JWT issue in one call.

| | |
| --- | --- |
| API container | `coracure-api:<sha>` from ECR, healthy, on `127.0.0.1:3000` |
| Database | `coracure-postgres` on the `coracure` network, 17 migrations applied |
| Seeded | 1 admin, 6 legal documents (placeholder version `0.0`) |
| Public URL | `https://3.111.230.242` — self-signed certificate until a domain exists |

The bootstrap admin password is at `/etc/coracure/.admin-bootstrap` (root, 0600)
and should be changed at first sign-in.

**Three deployment faults were found only by deploying**, all now fixed, and all
invisible to a passing test suite:

1. `node_modules` copied as root while the container runs as `node`, so the Prisma CLI refused to start and every migration would have failed.
2. `tsx` pruned as a dev dependency, so the documented seed command could not run at all.
3. The seed imports from `src`, which the runtime image did not carry.

Each surfaced one after the other, which is the argument for the `image` job in
CI building and *running* the artefact rather than only building it.

### Target instance state

The production instance is `3.111.230.242` (Amazon Linux 2023, `ec2-user`).
Its state as of 9 September 2026:

| Item | Status |
| --- | --- |
| Region / AZ | `ap-south-1`, private IP `172.31.2.48`, default VPC |
| Size | 2 vCPU, **913 MiB RAM** — undersized; move to `t3.small` before real users |
| Swap | **2 GB swapfile** at `/swapfile`, in `/etc/fstab`, `vm.swappiness=10` |
| Disk | 8 GB, **3.8 GB free** after the swapfile |
| Docker 25.0.14 | **installed, enabled, running** |
| nginx 1.30.4 + certbot 2.6.0 | **installed, enabled, running** |
| TLS certificate | self-signed placeholder — needs a domain |
| `/etc/coracure/` | **created**, `root:root`, mode 750 |
| SSM agent | running |
| Firewall | no firewalld, iptables ACCEPT — the security group is the only filter |
| SELinux | permissive |
| Security group | **only port 22** — 80 and 443 must be opened |
| IAM instance profile | **NOT ATTACHED** — this blocks the deploy |
| `/etc/coracure/api.env` | not created — needs the real secrets |
| Listening ports | 22 only; nothing is serving |
| Postgres | **container `coracure-postgres`** on the `coracure` network, volume `coracure-pgdata`, no host port. **No backups** |
| Redis | not needed — nothing reads it |
| `/etc/coracure/api.env` | **written**, root 0600, `NODE_ENV=development` until Slide and S3 exist |
| AWS account | `563524961006` |

The missing instance profile is the blocker. Without it the box has no AWS
credentials at all (`aws sts get-caller-identity` fails), so it cannot pull from
ECR, and the SSM agent — though running — cannot register as a managed instance
for `ssm:SendCommand` to reach.

Attach a role carrying `AmazonSSMManagedInstanceCore` and ECR read
(`ecr:GetAuthorizationToken`, `ecr:BatchGetImage`,
`ecr:BatchCheckLayerAvailability`, `ecr:GetDownloadUrlForLayer`), plus
`logs:CreateLogStream` and `logs:PutLogEvents` on `/coracure/api` for the
awslogs driver.

### Postgres on the instance

There is no RDS. Postgres 17 runs as a container on the box, decided
9 September 2026.

- Container `coracure-postgres`, `restart unless-stopped`, on the docker network `coracure`.
- Data in the named volume `coracure-pgdata`.
- **It publishes no host port.** It is reachable only from inside the `coracure` network, by container name, which is why every `docker run` in the release workflow passes `--network coracure`. Without that flag the API cannot see its database at all.
- Credentials are in `/etc/coracure/api.env` (root, 0600); the generated password is also at `/etc/coracure/.pgpw`.

**The risk this carries, stated plainly.** The database lives on the same 8 GB
root volume as everything else, and **nothing backs it up**. If the instance is
terminated or the volume is lost, every consultation, prescription, clinical
record and payment goes with it. There is no point-in-time recovery and no
snapshot. That is an accepted trade for now, not an oversight — but it is not a
position to be in when real patient data arrives.

The cheapest mitigation, when wanted: a nightly `pg_dump` from the container to
S3 with a lifecycle rule, plus one **tested** restore. An untested backup is a
guess. Moving to RDS remains the real answer.

### On the instance

The deploy expects, on each target EC2 instance:

- Docker, and the SSM agent running with an instance profile that can pull from ECR.
- `/etc/coracure/api.env` holding the runtime environment, owned by root and mode `600`. Secrets come from SSM Parameter Store into that file — never baked into the image, which is why `.dockerignore` excludes `.env`.
- A CloudWatch log group `/coracure/api`.

### Branch protection on `main`

Require the CI checks — `Lint, types and unit tests`, `End-to-end tests`,
`Migrations on a clean database`, `Image builds, boots and refuses a bad
configuration` — plus a review, and require branches to be up to date before
merging.

---

## 3. Deploying

**Automatic:** a merge to `main` runs `verify` → `publish` → `deploy` to
`staging`.

**To production:** Actions → Release → Run workflow → `production`. It waits on
the environment approval, then applies migrations and rolls the service.

Images are tagged with the seven-character commit sha. `:main` also moves, but
nothing deploys by it — "which build is running" must have exactly one answer.

### Release order

The order in the workflow is the one `DEPLOYMENT.md` prescribes and is not
incidental:

1. **Migrate**, as one SSM task on one instance, running the image about to be deployed. The migrations applied are exactly those the image was built from, so schema and code cannot disagree.
2. **Roll** the container. `docker stop --time 30` must exceed the longest in-flight request; the ALB deregistration delay must exceed that again, or the balancer keeps routing to a container that has stopped accepting.
3. **Verify** `/api/v1/health/ready` — readiness, not liveness. `/health` checks nothing, so a container with a dead database would pass it.

Migrations are forward-only. There is no automated rollback of a schema change:
rolling back the image while a migration stands is safe by design (migrations
are additive), but reverting a migration is a deliberate, written-down act, not
a pipeline button.

---

## 4. Rollback

```bash
# Re-deploy a known-good sha
aws ssm send-command --instance-ids <id> --document-name AWS-RunShellScript \
  --parameters commands="[
    'docker stop --time 30 coracure-api || true',
    'docker rm coracure-api || true',
    'docker run -d --name coracure-api --restart unless-stopped -p 3000:3000 --env-file /etc/coracure/api.env <registry>/coracure-api:<good-sha>'
  ]"
```

Or re-run the Release workflow from the earlier commit. Because every image is
sha-tagged and immutable, the previous build is always still there.

---

## 5. Known gaps

- **No staging/production parity test.** Nothing verifies that the environment on the instance matches what the image expects beyond the boot succeeding. The app's fail-fast validation covers most of it — a bad environment lists every problem at once and refuses to start — but a missing optional variable still deploys quietly.
- **Deploy is single-instance.** The workflow targets instances by `Name` tag and rolls them together. Behind an ALB with more than one instance this is a brief outage, not a rolling deploy. Moving to ECS or an ASG with instance refresh is the fix when a second instance exists; `DEPLOYMENT.md` deliberately starts at one.
- **No smoke test beyond readiness.** The deploy verifies the service is up and can reach its database. It does not exercise a sign-in or a booking.
