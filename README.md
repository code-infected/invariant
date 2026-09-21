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

Verified so far with a scripted stand-in for the model (see `TrialDeps.callModel`), plus
real-API runs with an invalid key to exercise the HTTP error path. No trial has run
against a real model yet.

Two known gaps before the full tier covers all three example tasks: the only tool server
in the repo is the refund one, so `run` refuses the code-agent and research tasks (it
checks that the tool server serves every tool a task declares, rather than handing the
agent the wrong tools); and every fixture has 5 variants while the full tiers ask for 6-8,
so those tiers run all 5 and say so rather than repeating phrasings.

Not built yet: the three scoring axes, the gate/CI integration, the dashboard, deployment
fingerprinting, OTel export, adversarial mode.

## Layout

```
tasks/                      task specs (*.yaml) and their variant fixtures (*.variants.json)
packages/cli/               the invariant CLI
packages/mcp-proxy/         transparent recording MCP proxy (the instrumentation layer)
packages/toy-tool-server/   a deterministic MCP tool server to test the proxy against
packages/agent-driver/      drives trials: model tool-use loop via the proxy, fan-out, retry policy
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
