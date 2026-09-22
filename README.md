# invariant

A black-box testing harness for AI agents that measures something standard evals don't:
whether an agent behaves the same way twice.

Given a task, invariant runs the agent under test many times, across paraphrasings of
the same instruction, and scores consistency across three independent axes: does the
final answer mean the same thing (outcome), does it take the same tool-call path
(tool-path), and, most importantly, does it make the same side-effecting calls with the
same arguments (state-mutation). It also supports an adversarial mode that plants a
hidden instruction in tool output and checks whether it hijacks the agent's behavior
several steps downstream.

## Status

Early, and honest about it.

Working:

- Task spec format, variant fixtures, and a CLI for authoring and validating both.
- An MCP proxy that sits between an agent and its real tool server, forwards every call
  transparently, records each one, and intercepts calls to tools the task spec marks
  dangerous, returning the spec's sandbox response instead of letting them reach the
  backend. Covered by end-to-end tests against a real tool server, including a negative
  control: with the tool not marked dangerous, the call really does reach the backend.
- A single-trial runner: one task, one variant, one trial, driven through the proxy,
  producing a complete trace record (run metadata plus the ordered tool-call sequence)
  in a local trace store.
- Fan-out: `invariant run --tier=smoke|full` runs every (variant x trial) cell the task
  spec's tier asks for, through a bounded worker pool, as one batch in the trace store.
  Provider infra failures (the statuses in `invariant.config.yaml`'s
  `providers.retry.retry_on`) are retried with backoff and never counted as a result;
  anything the agent actually did, including hitting its wall clock, counts on the first
  attempt.

- Scoring: `invariant score --batch=ID | --task=NAME` scores a batch on the three axes
  independently and saves the scores. The outcome axis needs `ANTHROPIC_API_KEY` for its
  judge; without it that axis is reported as not computed and the other two still score.
- A gate: `invariant gate` compares a batch's scores to the task's thresholds and exits
  0 (pass), 1 (an axis scored below its threshold) or 2 (could not evaluate), with a JSON
  report and a markdown one for a PR comment. See "Gate and CI" below.
- A GitHub Actions workflow (`.github/workflows/invariant.yml`): smoke tier on pull
  requests, full tier nightly.

Verified so far with a scripted stand-in for the model (see `TrialDeps.callModel`), plus
real-API runs with an invalid key to exercise the HTTP error path. No trial has run
against a real model yet, and the workflow has been linted (actionlint + shellcheck) but
has not run on GitHub yet. The scoring and gate proof points use a synthetic, clearly
labelled reproduction of the Princeton refund scenario (3 of 5 trials refund), not a
model result.

Two known gaps before the full tier covers all three example tasks: the only tool server
in the repo is the refund one, so `run` refuses the code-agent and research tasks (it
checks that the tool server serves every tool a task declares, rather than handing the
agent the wrong tools); and every fixture has 5 variants while the full tiers ask for 6-8,
so those tiers run all 5 and say so rather than repeating phrasings.

Not built yet: the dashboard, deployment fingerprinting, OTel export, adversarial mode,
and the embedding pre-filter's embedder (every non-identical pair of answers goes to the
judge).

## Layout

```
tasks/                      task specs (*.yaml) and their variant fixtures (*.variants.json)
packages/cli/               the invariant CLI
packages/mcp-proxy/         transparent recording MCP proxy (the instrumentation layer)
packages/toy-tool-server/   a deterministic MCP tool server to test the proxy against
packages/agent-driver/      drives trials: model tool-use loop via the proxy, fan-out, retry policy
packages/scoring/           the three consistency axes, and the gate's threshold comparison
packages/trace-store/       run/tool-call metadata + raw trace blobs (SQLite locally)
```

## Running it

```
npm install
npm run build                    # the packages import each other's build output
npm test                         # all package tests, no API key needed
npm run validate                 # validate every task spec + fixture

export ANTHROPIC_API_KEY=...     # required: a trial calls a real model
npm run invariant -- run --task=refund-duplicate-check --tier=smoke
npm run invariant -- run --task=refund-duplicate-check --variant=v1
npm run invariant -- variants regen --task=refund-duplicate-check
npm run invariant -- score --task=refund-duplicate-check
npm run invariant -- gate                    # every task's latest batch; exit 0/1/2
```

`run --tier=smoke|full` fans out. For each task (or just `--task`), it reads the tier's
`trials_*` and `variants_*` from the spec, takes the first N variants in fixture order
(never a random sample, so a tier always measures the same phrasings), and runs every
(variant x trial) cell, at most `execution.worker_concurrency` at a time (`--concurrency`
overrides). Omitting `--tier` uses `execution.default_tier`. It prints progress to stderr
and a summary to stdout: runs completed, infra attempts retried, cells whose retries ran
out, other errors, wall time, and tokens. It exits nonzero only when a cell ended without
a behavioural answer. Whether the answers agree is for the scoring engine to decide.

Retries are per cell. Every attempt is its own run row with its own tool calls, so the
evidence of a 429 is kept, but a retried attempt is flagged `superseded`. The run matrix
for scoring is `runs where batch_id = ? and superseded = 0`, one row per cell
(`TraceStore.getBatchRuns`). A cell that runs out of retries keeps its last attempt with
status `infra_error`: in the matrix, but plainly without an answer.

`run --variant=<id>` executes exactly one trial, with no retries, for debugging one case.
It loads the task spec and the named variant, starts the proxy (which starts the tool
server), gives the agent the proxy's tools, and writes the trace to `.invariant/`:
`trace.db` for metadata, `traces/<run_id>.json` for the full raw trace. Add `--json` to
print the whole record.

### Gate and CI

`invariant gate --batch=ID | --task=NAME` gates one batch (for `--task`, that task's
latest; an unfinished latest batch is refused rather than swapped for an older one). With
neither, it gates the latest batch of every task under `tasks/`, and tasks whose tools
the tool server does not serve are listed as "not gated" rather than dropped.

It reuses the batch's stored score when that score was computed from the same scoring
inputs (rubric, dangerous tools, volatile fields, judge settings) and has every axis;
otherwise it scores the batch first with the same code as `invariant score`. Thresholds
always come from `tasks/<name>.yaml` as it is now.

| Exit | Verdict | Meaning |
|---|---|---|
| 0 | `pass` | every axis scored and at or above its threshold |
| 0 | `pass_with_waivers` | nothing failed, but an axis had no score and `--allow-uncomputed` allowed it |
| 1 | `fail` | at least one scored axis is below its threshold (wins over a missing axis) |
| 2 | `incomplete` | an axis has no score, a runnable task has no finished batch, bad arguments, ... |

Missing scores fail closed. Without `ANTHROPIC_API_KEY` the outcome judge cannot run, and
a gate that passed anyway would be claiming a consistency nobody measured. Pass
`--allow-uncomputed=outcome` to accept that explicitly: the verdict is then
`pass_with_waivers`, never `pass`, and both reports say which axis went unchecked. Only
outcome can be waived; the other two axes need no model and are only missing when fewer
than two runs were scored.

`--json` prints the report (schema `invariant.gate/v1`, documented at the top of
`packages/cli/src/commands/gate.ts`), `--report=PATH` writes it, and `--markdown=PATH`
writes the PR-comment rendering. Failing axes carry the scoring evidence: the mutation
signature groups with the trials in each, the distinct tool paths, the outcome clusters.

The workflow runs `validate`, then `run --tier=... --runnable-only` (smoke on pull
requests, full nightly and on manual dispatch), then `gate`, uploads the JSON report and
the trace store as artifacts, and posts one PR comment that later runs edit in place. It
needs the `ANTHROPIC_API_KEY` repository secret; without it (including every pull request
from a fork, which never gets secrets) the job fails with a message saying so.

### How the instrumentation works

```
agent-driver  --MCP-->  mcp-proxy  --MCP-->  toy-tool-server
                            |
                            +--> trace store (every call: args, response, sandboxed flag)
```

The agent talks to the proxy exactly as it would talk to the real tool server — same tool
names, same JSON schemas, same responses — so instrumenting an agent means changing its
MCP server address and nothing else. Calls to tools listed under `tools.dangerous` in the
task spec are answered with that spec's `sandbox_response` and never forwarded, but are
still recorded, with `is_sandboxed` set, so a refund the agent tried to issue twice still
shows up in the trace.

The proxy is a transparent forward proxy, not a sandbox: it runs with the same
credentials the agent already had. The dangerous-tool list is the only thing it stops.

### Local trace store

The design calls for Postgres plus S3-compatible object storage. Locally that's SQLite
(`better-sqlite3`) and JSON files under `.invariant/`, because there is no database
server or bucket in a dev checkout and pretending otherwise would be worse than saying
so. The schema is kept deliberately SQL-portable, so moving to Postgres is a driver
change rather than a rewrite. See the comment at the top of `packages/trace-store/src/index.ts`.

## Why

Existing eval tools score a single run against a rubric. None of them treat variance
across repeated trials as the primary signal, which is a gap a 2026 Princeton RFC on AI
agent security names directly: an airline refund agent in their example approved the
same request 3 out of 5 times and denied it the other 2, with no code change between
runs. That's the failure mode this project targets.
