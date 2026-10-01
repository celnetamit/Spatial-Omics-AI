# Deploying the Spatial Omics AI LiveLab

One container, one port, one volume. No database, no second service, no
sidecar. This document covers what to set, what to check after a deploy, and
the failure modes that have actually happened on this platform.

---

## 1. Build

```bash
docker build --build-arg SOURCE_COMMIT=$(git rev-parse --short HEAD) -t spatial-ai .
```

`SOURCE_COMMIT` is not optional in practice. The build context has no `.git` —
Coolify and most CI builders send a tree, not a repository — so nothing in the
image can work out its own revision. The Dockerfile writes the argument to
`dist/COMMIT` and the server reports it at `/api/v1/meta`. Skip it and every
build reports `unknown`, and a deployment that cannot say what it is running is
one nobody can roll back with confidence.

**On Coolify:** set it as a *build variable* (not an environment variable) named
`SOURCE_COMMIT`. Environment variables are injected at run time, after the
`ARG` no longer exists.

The build runs `npm run verify` — typecheck, all 207 tests, then the production
build — followed by `npm run content:validate`. A failing test is a failing
build. That is deliberate: the image is what ships, so it is what gets tested.

Expect 4–8 minutes. Most of it is `npm ci` and the TypeScript build.

---

## 2. Required configuration

Only one variable has to be set for a correct deployment:

```
SPATIAL_SESSION_SECRET=<64 hex characters>
```

Generate with `openssl rand -hex 32`. Shorter than 32 characters is treated as
unset. When it is unset the server generates one, logs a warning, and runs —
sessions then do not survive a restart and cannot be shared across replicas.
That is a real consequence, not a nag: users are signed out on every redeploy.

Everything else has a working default. The ones a real deployment usually
changes:

```
LAB_AUTH_VERIFY_URL=https://live-labs.org/api/auth/authorize-lab
LAB_SLUG=spatial-ai
SPATIAL_RUN_CONCURRENCY=1
SPATIAL_AI_ENABLED=false
```

See the configuration table in [README.md](README.md#configuration) for the full
list.

### Before enabling AI interpretation

`SPATIAL_AI_ENABLED=true` needs either `GEMINI_API_KEY` or an OpenAI-compatible
`SPATIAL_AI_BASE_URL`. With neither, the adapter abstains on every request and
says so at boot. The lab is fully usable with AI off — interpretation panels
show the numbers and the evidence without the prose.

### Before enabling research exports

`SPATIAL_RESEARCH_EXPORTS=true` warns at boot to confirm ethics approval and the
consent flow. The export is also gated on the `export-research` capability,
which no learner holds. Both gates, not either.

---

## 3. The volume

```
-v spatial-ai-data:/app/data
```

`/app/data` holds projects, runs, run artefacts and uploads. It is the only
state the container keeps. Without a volume, every redeploy loses every user's
work — and because the lab looks perfectly healthy afterwards, the loss is
discovered by a user rather than by the deploy.

The image creates `/app/data` owned by `node` before dropping privileges, so a
named volume arrives writable. A *bind mount* from the host does not: it arrives
owned by whoever owns the host directory. If the container logs `EACCES` on
startup, `chown 1000:1000` the host path.

---

## 4. Resources

| | Minimum | Comfortable |
|---|---|---|
| Memory | 1.5 GB | 3 GB |
| CPU | 1 core | 2 cores |
| Disk | 2 GB | 10 GB + growth |

A propagation run on a 2,400-cell section holds the full per-stage tissue state
— a few hundred megabytes. The parent process is capped at 1536 MB
(`NODE_OPTIONS`), each worker has its own heap cap, and `SPATIAL_RUN_CONCURRENCY`
defaults to `1` for that reason. Raising it above 2 warns at boot. Two
concurrent runs on a small container is how the process gets killed by the OOM
reaper mid-run, which looks to the user like the lab silently losing their work.

The model pack adds roughly 40 MB to the image. Disk growth after that is user
uploads and run artefacts, in `/app/data`.

---

## 5. Routing

The container serves the API and the client from the same origin, so there is no
CORS configuration to get wrong. Point the proxy at the container port and set
no CORS headers on the app — an app-wide CORS layer here has previously
500'd static assets and taken the whole frontend down.

Two things the reverse proxy must allow:

- **Long-lived responses.** Runs stream progress. A 30-second proxy read timeout
  cuts a propagation run off mid-stream; the client shows a network error and
  the run completes invisibly on the server. Allow at least
  `SPATIAL_RUN_TIMEOUT_MS` (300 s by default) plus a margin.
- **Uploads up to `SPATIAL_MAX_UPLOAD_MB`** (64 MB by default). A proxy body
  limit below this rejects the upload before the server can explain what is
  wrong with it.

**On this host specifically:** Apache serves `.88` and localhost while the
Coolify proxy holds `173.199.130.49`. Check which service holds the domain
before debugging a routing problem in the wrong process.

---

## 6. After deploying, check these five things

```bash
BASE=https://your-host

curl -s $BASE/healthz | jq
curl -s $BASE/api/v1/meta | jq '{version, commit, authEnabled,
                                  modelPack: .modelPack.version, ai: .ai.available}'
```

1. **`/healthz` returns 200 and lists the cases.** It reports the content
   catalogue, not just liveness, so a container that booted without its cases
   fails this rather than serving an empty lab. The Docker `HEALTHCHECK` uses
   the same endpoint.
2. **`commit` in `/api/v1/meta` is the revision you built**, not `unknown`.
3. **`modelPack` is present** if you expect prediction, uncertainty and rescue
   to work. If it is absent those stages report themselves unavailable, with the
   reason, and the rest of the lab works normally.
4. **The boot log has no warnings you did not intend.** Every one of them names
   a real consequence — a generated session secret, disabled authentication, a
   dev role in production, research exports enabled.
5. **Open the lab in a browser and create a project.** The server can be
   perfectly healthy while the client fails to load: check the browser *console*,
   not just the network tab. A frontend CSP that does not list the backend origin
   produces "Failed to fetch" with no network row at all.

---

## 7. Failure modes worth recognising

**A run reaches ~76% and the client reports `ECONNRESET`, with nothing in the
server log.** This was the pre-worker-thread architecture: scientific work
blocked the event loop past `keepAliveTimeout` and Fastify never got to log
anything. If it reappears, something has moved back onto the main thread — look
for a call into `engine/` from a route handler rather than through
`server/src/jobs/runner.ts`.

**Users signed out after every deploy.** `SPATIAL_SESSION_SECRET` is unset or
too short. Check the boot log.

**Every launch from the hub is refused.** The hub needs a `Lab` row for this
slug. No row means every launch is refused, regardless of what the lab does.
`LAB_SLUG` must match it.

**Advanced mode refused for an admin or reviewer.** Advanced is a paid tier; the
exemption for reviewers and administrators lives in this lab's server
(`server/src/routes/shared.ts`), not on the hub. If an exempt user is being
refused, the identity from `authorize-lab` is what to inspect — `isReviewer` and
the role list, never the launch token.

**Restart leaves the old build serving.** Killing the process by name can leave
a renamed child alive holding the port. Kill by port.

---

## 8. Updating the content packs

The model pack and the evidence snapshot are *content*, not code, and are
regenerated by tools rather than edited:

```bash
npm run case:generate      # frozen demonstration cases
npm run evidence:fetch     # ChEMBL snapshot (rate-limited, resumable)
npm run model:train        # the propagation model pack
npm run content:validate   # the joins between all of them
```

`content:validate` is the gate. It checks what the individual packs cannot check
about themselves — that every compound's target resolves to a node in the
regulatory network, that every case was frozen against the network that is
actually compiled, that each case's checksum still matches its bytes, that the
model card carries all seven §14.3 baselines and states what its metrics mean.

A compound whose target does not resolve produces no error at run time. It
simulates as no effect, and the lab reports that the compound did nothing. Run
the validator after changing the network, and treat a failure as a blocked
deploy.
