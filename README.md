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

Early. Task spec format, variant fixtures, and a CLI for authoring and validating both
are in place. Execution against a real agent, scoring, and CI integration are not built
yet.

## Layout

```
tasks/            task specs (*.yaml) and their variant fixtures (*.variants.json)
packages/cli/     the invariant CLI
```

## CLI

```
npm install
npm run validate                 # validate every task spec + fixture

npx tsx packages/cli/src/index.ts init
npx tsx packages/cli/src/index.ts variants regen --task=<name>   # requires ANTHROPIC_API_KEY
```

## Why

Existing eval tools score a single run against a rubric. None of them treat variance
across repeated trials as the primary signal, which is a gap a 2026 Princeton RFC on AI
agent security names directly: an airline refund agent in their example approved the
same request 3 out of 5 times and denied it the other 2, with no code change between
runs. That's the failure mode this project targets.
