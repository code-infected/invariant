"""invariant-langgraph: run a LangGraph agent through an invariant task, write trace files.

    invariant-langgraph run --task NAME --tier smoke|full --graph module:factory \\
        --tools module:attr --out DIR [--model ID | --model-factory module:attr]

Then import the files with the TypeScript CLI:  invariant ingest --task=NAME --tier=TIER DIR
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from .driver import DEFAULT_MAX_TURNS, DEFAULT_MODEL, DEFAULT_REPLY_TOOL, anthropic_model_factory, load_object, run_batch, tool_source
from .spec import SpecError, find_repo_root, load_task, select_cells
from .trace_file import TraceFileError, load_schema


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="invariant-langgraph", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run", help="run a tier's (variant x trial) cells and write one trace file per cell")
    run.add_argument("--task", required=True, help="task name (tasks/<name>.yaml)")
    run.add_argument("--tier", required=True, choices=["smoke", "full"])
    run.add_argument("--graph", required=True, help="module:factory, called as factory(tools, model) -> compiled graph over {'messages': [...]}")
    run.add_argument("--tools", required=True, help="module:attr, a list of LangChain tools or a zero-arg callable returning one (called per trial)")
    run.add_argument("--out", required=True, type=Path, help="directory for the trace files (must not already hold any .json)")
    model = run.add_mutually_exclusive_group()
    model.add_argument("--model", default=None, help=f"Anthropic model id via langchain-anthropic (default {DEFAULT_MODEL}); needs ANTHROPIC_API_KEY")
    model.add_argument("--model-factory", default=None, help="module:attr, called as factory(cell) -> chat model, instead of --model")
    run.add_argument("--variants", default=None, help="comma-separated variant ids, overriding the tier's selection")
    run.add_argument("--trials", type=int, default=None, help="trials per variant, overriding the tier's count")
    run.add_argument("--max-turns", type=int, default=DEFAULT_MAX_TURNS)
    run.add_argument("--reply-tool", default=DEFAULT_REPLY_TOOL, help="tool whose 'message' argument is the run's final output")
    run.add_argument("--repo-root", type=Path, default=None, help="invariant repo (default: nearest ancestor with tasks/ and schemas/)")
    return p


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    log = lambda m: print(m, file=sys.stderr)  # noqa: E731
    try:
        repo = args.repo_root.resolve() if args.repo_root else find_repo_root()
        task = load_task(repo, args.task)
        selection = select_cells(
            task,
            args.tier,
            variant_ids=[v.strip() for v in args.variants.split(",") if v.strip()] if args.variants else None,
            trials=args.trials,
        )
        schema = load_schema(repo)
        out = args.out.resolve()
        if out.exists() and any(out.glob("*.json")):
            raise SpecError(f"{out} already holds .json files; use an empty directory so one ingest is one batch")
        if args.model_factory:
            model_factory = load_object(args.model_factory)
        else:
            model_factory = anthropic_model_factory(args.model or DEFAULT_MODEL, os.environ.get("ANTHROPIC_API_KEY"))
        graph_factory = load_object(args.graph)
        tools = tool_source(load_object(args.tools))

        n = len(selection.variants) * selection.trials
        log(
            f"{task.name}: {selection.tier} tier, {len(selection.variants)} variant(s) x {selection.trials} trial(s) = {n} runs"
            + (" (shape overridden by --variants/--trials)" if selection.overridden else "")
        )
        result = run_batch(
            task=task,
            selection=selection,
            tools=tools,
            model_factory=model_factory,
            graph_factory=graph_factory,
            out_dir=out,
            schema=schema,
            max_turns=args.max_turns,
            reply_tool=args.reply_tool,
            log=log,
        )
    except (SpecError, TraceFileError, RuntimeError, ValueError, ImportError, AttributeError) as err:
        print(str(err), file=sys.stderr)
        return 1
    counts = ", ".join(f"{v} {k}" for k, v in result.statuses.items())
    print(f"wrote {len(result.files)} trace file(s) to {out} ({counts}), batch key {result.batch_key}")
    print(f"import them: invariant ingest --task={task.name} --tier={selection.tier} {out}")
    return 0 if set(result.statuses) <= {"ok", "timeout"} else 1


if __name__ == "__main__":
    sys.exit(main())
