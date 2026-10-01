# Spatial Omics AI Virtual LiveLab

A teaching and research lab for spatial perturbation propagation. A user picks a
spatial transcriptomics section, perturbs it — a gene knockout, an
overexpression, or a real compound at a real concentration — and the lab
simulates how that perturbation spreads through the tissue, then compares
candidate rescue interventions against the altered state.

Implements the *Full Scientific Methodology, Product Design & IT Implementation
Handbook* v1.0 (21 August 2026).

---

## The one rule that shaped everything else

> **§1.4 — LLM-generated numerical biology is not allowed.**

Every number the lab displays comes from an explicit method: a solver, a
statistical test, a trained model with a published validation table, or a
retrieved measurement with a citation. The language model has exactly one job —
writing prose about numbers that already exist — and it is prevented from doing
anything else by a gate that parses its output and rejects it (see
[server/src/ai/gate.ts](server/src/ai/gate.ts)).

The gate rejects a draft for any of: an unattributable number, an unknown claim
id, a claim without a citation, vocabulary outside the approved list, clinical
advice, a certainty claim, or causal language the evidence does not support. A
rejected draft is not retried with a softer prompt; the interpretation panel
shows the numbers with no prose and says why.

This is enforced, not documented. `server/tests/gate.test.ts` holds 18 cases
including the ones that caught real bugs: a draft citing "SMAD3" was once
rejected because the extractor read `3` as a fabricated number.

---

## Running it

```bash
npm install
npm run case:generate        # writes content/case/*.json (deterministic)
npm run model:train          # trains the propagation model pack (~1h on 4 cores)
npm run verify               # typecheck, 207 tests, build
npm start                    # http://localhost:3000
```

The lab runs without the model pack. Analysis, perturbation, direct response and
the whole baseline workflow work; prediction, uncertainty and rescue report
themselves unavailable with the reason, rather than falling back to something
weaker. `npm run content:validate` says which packs are installed.

For development, two processes:

```bash
npm run dev:server           # API on :3000
npm run dev                  # Vite on :5173, proxying /api to :3000
```

Set `SPATIAL_AUTH_ENABLED=false` to work without the hub. Every visitor is then
a learner on the Beginner tier; `SPATIAL_DEV_ROLE=admin` raises that, and is
ignored when `NODE_ENV=production` so a mis-set variable cannot open a
deployment.

### Docker

```bash
npm run docker:build         # runs npm run verify inside the build
npm run docker:run
```

The test suite runs in the image build. A green checkout and a red container are
the same repository in two states, and the container is the one that ships.

---

## How the science is put together

```
 data ──▶ QC ──▶ preprocess ──▶ annotate ──▶ baseline ──▶ spatial ──▶ communication
                                                                          │
                          ┌───────────────────────────────────────────────┘
                          ▼
   perturbation ──▶ direct response ──▶ graph ──▶ propagation ──▶ altered tissue
                          │                           │
                          │                           ├──▶ adverse effects
                          │                           └──▶ uncertainty
                          ▼
   rescue candidates ──▶ rescue simulations ──▶ comparison ──▶ interpretation ──▶ report
```

Twenty-one stages, defined once in [engine/src/pipeline.ts](engine/src/pipeline.ts)
and mapped to the handbook's step numbers. The UI derives its state from that
graph rather than keeping its own copy, so a stage cannot be reachable in the
interface and absent from the engine.

**Three things in that diagram are load-bearing and worth reading about before
changing anything.**

### 1. Direct response is computed and stored separately from propagation (§2.3)

A drug's effect on the cells that express its target is one calculation. What
that does to the rest of the tissue is another. They are separate artefacts,
separately exportable, and the report shows them separately — because a merged
number cannot answer "did this spread, or did it only act where it landed?",
which is the question the lab exists to ask.

### 2. Every candidate is simulated before anything is ranked (§2)

The rescue stage does not score candidates from a heuristic and then simulate
the winner. It simulates each eligible candidate separately in the same altered
tissue state, and only then compares. That is slower and it is the point: a
ranking produced before simulation is a ranking of the heuristic.

The comparison stage will also refuse to produce a ranking. If the separation
between candidates is an artefact of min-max scaling rather than a difference in
the underlying quantities, `degenerateComponents` detects it and the result says
"no clear winner… an artefact of the scaling rather than a finding" instead of
printing an order.

### 3. Beginner, Intermediate and Advanced return identical numbers (§3)

Same configuration, same numbers, in all three modes. What changes is which
controls are exposed, how much guidance is shown, which diagnostics are
available and how deep the export goes. A project analysed in Beginner mode and
reopened in Advanced keeps its completed stages untouched.

---

## The tissue model

The mechanistic solver ([engine/src/propagate/mechanism.ts](engine/src/propagate/mechanism.ts))
is a reaction–diffusion system over a curated regulatory network: 66 nodes
across 8 pathways, 86 signed edges each carrying the basis for its sign, and 10
secreted signals with diffusion lengths from 25 to 150 µm.

Two details took several attempts and both are load-bearing:

**Edges respond to deviation from a cell's own resting state, not from a global
constant.** Centring on network-wide basal made the solver read cell identity as
repression — a T cell not expressing COL1A1 looked like a fibroblast with COL1A1
knocked down — and the baseline oscillated with a delta of 0.46. Edges now
centre on `capacity × basal`, which is that cell's resting level for that node.

**Ligand response is a log ratio against the section's own mean field**, found
by a two-pass burn-in. Against a fixed basal constant, every receptor in the
section read as suppressed.

Both are `tanh`-squashed with a loop gain low enough to be stable
(`EDGE_GAIN 2.0 / EDGE_SCALE 0.4`, slope 5 at the origin). The earlier linear
version sat in the flat part of the sigmoid and propagated ~0.0004.

`engine/tests/mechanism.test.ts` asserts the two properties that make this a
spatial model rather than a per-cell one: an unperturbed cell responds and the
response decays with distance, and knocking out a ligand propagates further than
knocking out its receptor.

---

## The learned model, and what it does not claim

The propagation model is a deep ensemble of edge-type-aware message-passing
GNNs, hand-written forward and backward, trained on simulations from the
mechanistic solver.

**It reproduces the simulator it was trained on. It is not validated against
tissue.** The model card says this in those words, and the sentence is required:
`content:validate` fails a pack whose card omits `whatTheMetricsMean`.

`content/packs/propagation-model/model-card.json` carries the §14.3 table — all
seven minimum baselines — and the §14.4 split. The metric that matters is
`firstNeighbourR2`, restricted to cells one hop from a perturbed cell, because
a whole-section R² is dominated by the cells that did not change and a
predict-zero model scores well on it. `gnn-shuffled` (same architecture, edges
permuted) is in the table for the same reason: if it matches `gnn`, the model is
not using the graph.

Splits are at section level, never cell level. `splitIsClean` asserts it and the
training run refuses a split that fails.

---

## Evidence and provenance

| What | Where from | Marked as |
|---|---|---|
| Compound potency | ChEMBL REST API, frozen snapshot, IC50/Ki only | retrieved |
| Action type, mechanism text | curated from standard pharmacology | curated |
| Pathway sets, marker panel, LR pairs | curated for this lab, identifiers given | curated |
| Simulation parameters | the §5 registry, each with a source or marked exploratory | per-parameter |
| Anything the model produced | the model pack, with its card | model output |

Four of the 22 compounds have no usable potency measurement. The lab refuses to
simulate them rather than substituting a plausible concentration, and each is
named in the pack's `problems` list. That list is now *derived from the records
at write time* — an accumulated list went stale across a resumed fetch and
bevacizumab shipped with no potency and no declaration of it, which the content
validator caught.

A potency measured against one molecule and applied to a different model node is
recorded as such: the schema carries `indirect`, `indirectNote`,
`potencyMeasuredAgainst` and `appliedToModelNode`, because recording ruxolitinib
as "STAT3, IC50 x nM" — its measurement is against JAK2, and the network has no
JAK2 node — would assert a measurement nobody made. **No shipped record uses
it.** Ruxolitinib is the compound that forced the fields and it has no ChEMBL
molecule record under that preferred name, so it is not in the pack; the 22
compounds that are all have potency against their own target. The machinery is
present and unexercised, which is worth knowing before trusting it.

The bundled demonstration case is generated by the same curated network the gene
sets are drawn from. On that dataset a pathway score measures the simulator
rather than confirming it, and `RESOURCE_PROVENANCE.circularityNote` says so
wherever the sets are displayed.

---

## What it deliberately does not do

[content/register.ts](content/register.ts) is the implementation register: one
row per handbook capability, including the rows that say a capability is absent,
partial, or present as an engineering guardrail rather than a scientific claim.
It is shown to every user, not only to auditors — a lab that publishes its
limitations only to the people auditing it is telling two different stories.

The short version:

- **No universal biological defaults** (§5). A parameter with a default has a
  source, or is marked exploratory and says so at the point of use. Engineering
  guardrails — iteration caps, memory budgets — are labelled as such and never
  presented as biology.
- **Extrapolation is off by default** (§5.3). A concentration outside the tested
  range is refused with the range that was tested.
- **No universal QC threshold** (§6.3). Thresholds are derived per dataset;
  `predictionEligible` is a separate verdict from the QC pass/fail.
- **No composite score** (§6.19) without frozen, justified, benchmarked,
  reviewer-approved weights. There are none, so comparison is by Pareto front
  and per-endpoint tables.
- **Simulation stages are not hours or days** (§7.8). They are stages, and the
  interface never converts them.
- **Not a clinical treatment recommendation system.** Stated on every screen.

---

## Configuration

Everything except the sign-in portal links is runtime, so a deployment can be
reconfigured and restarted without a rebuild.

| Variable | Default | What it does |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | listen address |
| `SPATIAL_SESSION_SECRET` | *generated* | under 32 chars is treated as unset; a generated secret means sessions do not survive a restart, and the server says so at boot |
| `SPATIAL_DATA_ROOT` | `data` | projects, runs, uploads — mount this |
| `SPATIAL_AUTH_ENABLED` | `true` | `false` makes every visitor a Beginner-tier learner |
| `SPATIAL_DEV_ROLE` | — | development only; ignored when `NODE_ENV=production` |
| `LAB_AUTH_VERIFY_URL` | `https://live-labs.org/api/auth/authorize-lab` | hub identity endpoint |
| `LAB_SLUG` | `spatial-ai` | this lab's slug on the hub |
| `SPATIAL_RUN_CONCURRENCY` | `1` | concurrent scientific jobs; each holds the full per-stage tissue state |
| `SPATIAL_RUN_TIMEOUT_MS` | `300000` | hard wall-clock kill per job |
| `SPATIAL_MAX_OBSERVATIONS` | `20000` | upload ceiling in cells |
| `SPATIAL_AI_ENABLED` | `false` | interpretation prose; the lab is fully usable without it |
| `SPATIAL_AI_BASE_URL` | — | an OpenAI-compatible gateway, used instead of the provider |
| `SPATIAL_RESEARCH_EXPORTS` | `false` | enabling it warns at boot to confirm ethics approval |
| `SOURCE_COMMIT` | `unknown` | build argument; the Dockerfile stamps it to `dist/COMMIT` |

Boot warnings are in `startupWarnings()` and are printed, not swallowed.

---

## Architecture

One process, one port. Fastify serves the API and the built client from the same
origin, so there is no CORS surface and no second deployment to keep in step.

**Scientific work runs in worker threads, never on the event loop.** This is not
an optimisation. With the pipeline running inline, a propagation job blocked the
loop past `keepAliveTimeout`; the client saw `ECONNRESET` at 76% and the server
log showed nothing at all. Each job now runs in a worker with its own heap cap
and a hard wall-clock kill, forwarding artefacts to the parent
([server/src/jobs/](server/src/jobs/)).

```
engine/          the science. No Fastify, no React, no I/O beyond reading a file.
  core/          RNG, statistics, linear algebra, provenance
  propagate/     the regulatory network, the mechanistic solver, the GNN
  validate/      training corpus, splits, the seven baselines
server/          Fastify, worker-thread job runner, the AI gate, auth
content/         parameter registry, curated resources, evidence, frozen cases
components/      React; pages are lazy-loaded route components
```

The engine has no dependency on the server and is tested without one. If a
number is wrong, it is wrong in `engine/`.

**Determinism.** One seed per run, from which named independent streams are
derived (`RandomState.stream(label)`). Independent streams mean adding a draw in
one place cannot shift a p-value somewhere else — a coupling that did bite once,
when the direct path moved because the element count changed.

**Two notes for anyone editing the build.** Do not add `manualChunks` to the
Vite config: it defeats the lazy route loading, and the symptom is visible in
the `modulepreload` tags rather than in the chunk-size table. And avoid
`export *` barrel imports from the engine into client code — one of them put the
whole engine in the entry bundle.

---

## Tests

```bash
npm test
```

207 tests. The ones worth knowing about:

- `engine/tests/statistics.test.ts` — the distribution functions against SciPy
  values at 1e-12 relative, including far-tail cancellation. The shipped erf was
  a rational approximation until a 1.9e-8 mismatch showed up; it is now built on
  the incomplete gamma function.
- `engine/tests/mechanism.test.ts` — propagation reaches unperturbed cells,
  decays with distance, and distinguishes a ligand knockout from a receptor one.
- `engine/tests/gnn.test.ts` — analytic gradients against finite differences.
- `server/tests/gate.test.ts` — the AI gate's rejections.
- `server/tests/authorisation.test.ts` — capabilities fail closed; a capability
  nobody declared is refused rather than allowed.
- `server/tests/disclosure.test.ts` — boots the real routes and asks what one
  account can read of another's. Somebody else's run returns 404, not 403: a 403
  confirms the id is real, which is itself a disclosure on ids that appear in
  URLs.
- `tests/reviewerAgreement.test.ts` — the org-wide reviewer agreement, asserted
  byte-for-byte by fingerprint.
- `tests/crossModeIdentity.test.ts` — §3, enforced structurally rather than by
  comparing outputs: no lab mode reaches `engine/`, and adding `mode` to a
  worker task fails `tsc` before any test runs.
- `engine/tests/uncertainty.test.ts` — the out-of-domain check. A feature the
  training corpus held constant must not contribute to the distance: it once
  scored the demonstration case at 1900 standard deviations and made every real
  run "out of domain" for a reason that was arithmetic rather than tissue.
- `server/tests/report.test.ts` — the report spans the project's runs. Every
  section must be reachable from any of them, or the document is structurally
  incapable of being complete.

`npm run content:validate` is separate and checks the joins *between* content
packs: a compound whose target is not a node in the network does not crash, it
simulates as no effect, and the lab then reports that the compound did nothing.
That reads as a result. It is a missing string match.
