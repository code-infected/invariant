"""Drive a LangGraph graph over a task's (variant x trial) cells and write one trace file per cell.

For each cell: fresh tools (the user's tool source), the task's dangerous tools wrapped by
the sandbox, a fresh model (the model factory), the user's graph built from both, and one
run of that graph on the variant's text with a TraceRecorder attached through the run
config. The outcome is written as a trial trace file (trace_file.py), validated against
the checked-in schema first. Cells run one at a time.

Status mapping, the same categories as the MCP driver (packages/agent-driver):
  ok           the graph finished. stop_reason reply_to_user if the reply tool was
               called (its message is the final output), else end_turn (the last AI
               message's text is the final output).
  timeout      max_wall_clock_seconds elapsed (wall_clock_timeout), or the graph hit its
               recursion limit, 2 x max_turns + 1 supersteps (max_turns).
  infra_error  the graph raised. error.kind: provider for a transient provider failure
               (429, 5xx, timeouts, connection errors), provider_rejected for any other
               4xx, harness for everything else. There is no retry: the cell is recorded
               as infra_error and scoring excludes it, as it excludes any run without a
               behavioural answer.
"""
from __future__ import annotations

import asyncio
import importlib
import time
import uuid
from dataclasses import dataclass
from importlib import metadata as importlib_metadata
from pathlib import Path
from typing import Any, Callable, Iterable

from langchain_core.messages import AIMessage, HumanMessage, messages_to_dict
from langchain_core.tools import BaseTool
from langchain_core.utils.function_calling import convert_to_openai_tool
from langgraph.errors import GraphRecursionError

from . import ADAPTER_NAME, __version__
from .recorder import TraceRecorder, _jsonable, iso_now
from .sandbox import sandbox_tools
from .spec import Selection, Task
from .trace_file import FORMAT, trace_filename, write_trace

DEFAULT_MODEL = "claude-sonnet-4-5"  # packages/agent-driver DEFAULT_MODEL
DEFAULT_MAX_TURNS = 12
DEFAULT_REPLY_TOOL = "reply_to_user"

MISSING_KEY_MESSAGE = (
    "ANTHROPIC_API_KEY is not set. Running a trial drives the agent under test through "
    "the real Anthropic API and needs a real key, there is no offline fallback because "
    "a faked agent response would produce a trace that measures nothing. Set the key "
    "and re-run (or pass --model-factory to drive the graph with a model of your own)."
)


@dataclass(frozen=True)
class CellInfo:
    """What a model factory is told about the cell it is building a model for."""

    task: str
    tier: str
    variant_id: str
    variant_text: str
    trial: int


ToolSource = Callable[[], list[BaseTool]]
ModelFactory = Callable[[CellInfo], Any]
GraphFactory = Callable[[list[BaseTool], Any], Any]


def load_object(ref: str) -> Any:
    """Import "package.module:attribute"."""
    module_name, sep, attr = ref.partition(":")
    if not sep or not module_name or not attr:
        raise ValueError(f"expected module:attribute, got {ref!r}")
    obj: Any = importlib.import_module(module_name)
    for part in attr.split("."):
        obj = getattr(obj, part)
    return obj


def tool_source(obj: Any) -> ToolSource:
    """A list of tools, or a zero-argument callable returning one (called once per cell)."""
    if callable(obj) and not isinstance(obj, BaseTool):
        return lambda: list(obj())
    tools = list(obj)
    return lambda: tools


def anthropic_model_factory(model_id: str, api_key: str | None) -> ModelFactory:
    if not api_key:
        raise RuntimeError(MISSING_KEY_MESSAGE)
    from langchain_anthropic import ChatAnthropic

    def factory(_cell: CellInfo) -> Any:
        # max_retries=0: a provider failure must surface as this cell's infra_error, not be
        # retried invisibly inside one recorded run.
        return ChatAnthropic(model=model_id, api_key=api_key, max_retries=0)

    return factory


def tool_schema(tools: Iterable[BaseTool]) -> list[dict[str, Any]]:
    """The tools as offered to the agent: name, description, input JSON schema, in order."""
    out = []
    for t in tools:
        fn = convert_to_openai_tool(t)["function"]
        out.append({"name": fn["name"], "description": fn.get("description", ""), "input_schema": fn.get("parameters", {})})
    return out


def classify_error(err: BaseException) -> dict[str, Any]:
    status = getattr(err, "status_code", None)
    if status is None:
        status = getattr(getattr(err, "response", None), "status_code", None)
    kind = "harness"
    try:
        import anthropic

        if isinstance(err, (anthropic.APITimeoutError, anthropic.APIConnectionError)):
            kind = "provider"
    except ImportError:  # pragma: no cover - langchain-anthropic is a dependency
        pass
    if isinstance(status, int):
        kind = "provider" if status in (408, 429) or status >= 500 else "provider_rejected" if 400 <= status < 500 else kind
    error: dict[str, Any] = {"kind": kind, "message": f"{type(err).__name__}: {err}"}
    if isinstance(status, int):
        error["http_status"] = status
    return error


def framework_versions() -> dict[str, str]:
    out = {}
    for pkg in ("langgraph", "langchain-core", "langchain-anthropic"):
        try:
            out[pkg] = importlib_metadata.version(pkg)
        except importlib_metadata.PackageNotFoundError:
            pass
    return out


def _last_ai_text(messages: list[Any]) -> str | None:
    for m in reversed(messages):
        if isinstance(m, AIMessage):
            return m.content if isinstance(m.content, str) else "".join(
                b.get("text", "") for b in m.content if isinstance(b, dict) and b.get("type") == "text"
            )
    return None


def run_cell(
    *,
    task: Task,
    selection: Selection,
    batch_key: str,
    variant_id: str,
    variant_text: str,
    trial: int,
    tools: list[BaseTool],
    model: Any,
    graph_factory: GraphFactory,
    max_turns: int = DEFAULT_MAX_TURNS,
    reply_tool: str = DEFAULT_REPLY_TOOL,
    timeout_s: float | None = None,
) -> dict[str, Any]:
    """Run one cell and return its trace (not yet written)."""
    offered = sandbox_tools(tools, task.dangerous)
    recorder = TraceRecorder()
    started_at = iso_now()
    t0 = time.monotonic()
    status, stop_reason, error = "ok", "end_turn", None
    messages: list[Any] = [HumanMessage(content=variant_text)]
    graph = graph_factory(offered, model)
    config = {"callbacks": [recorder], "recursion_limit": 2 * max_turns + 1}

    async def invoke() -> Any:
        return await graph.ainvoke({"messages": list(messages)}, config=config)

    try:
        result = asyncio.run(asyncio.wait_for(invoke(), timeout=timeout_s if timeout_s is not None else task.max_wall_clock_seconds))
        messages = list(result.get("messages", messages)) if isinstance(result, dict) else messages
    except asyncio.TimeoutError:
        status, stop_reason = "timeout", "wall_clock_timeout"
    except GraphRecursionError:
        status, stop_reason = "timeout", "max_turns"
    except Exception as err:  # noqa: BLE001 - every failure is recorded, then the batch moves on
        status, stop_reason, error = "infra_error", "error", classify_error(err)
    latency_ms = int((time.monotonic() - t0) * 1000)

    replies = [c for c in recorder.tool_calls if c["tool_name"] == reply_tool]
    final_output: str | None = None
    if replies:
        message = replies[-1]["args"].get("message")
        final_output = message if isinstance(message, str) else None
        if status == "ok":
            stop_reason = "reply_to_user"
    elif status == "ok":
        final_output = _last_ai_text(messages)

    fingerprint = None
    if recorder.model_responses > 0:
        fingerprint = {
            "model_name": recorder.model_names[0] if recorder.model_names else "(not reported by the model object)",
            "model_version": recorder.model_versions[0] if recorder.model_versions else "(not reported by the API)",
            "system_prompt": recorder.system_prompt,
            "tool_schema": tool_schema(offered),
        }

    return {
        "format": FORMAT,
        "adapter": {"name": ADAPTER_NAME, "version": __version__, "framework": framework_versions()},
        "task": task.name,
        "tier": selection.tier,
        "batch": {
            "key": batch_key,
            "trials_per_variant": selection.trials,
            "variants_requested": selection.variants_requested,
            "variant_labels": [v.id for v in selection.variants],
        },
        "variant": {"id": variant_id, "text": variant_text, "fixture_version": task.fixture_version},
        "trial": trial,
        "status": status,
        "stop_reason": stop_reason,
        "error": error,
        "final_output": final_output,
        "started_at": started_at,
        "finished_at": iso_now(),
        "latency_ms": latency_ms,
        "usage": {"input_tokens": recorder.input_tokens, "output_tokens": recorder.output_tokens},
        "fingerprint": fingerprint,
        "tool_calls": recorder.tool_calls,
        "messages": _jsonable(messages_to_dict(messages)),
    }


def check_tools(task: Task, tools: list[BaseTool]) -> list[str]:
    """Refuse (return problems) when the tools do not cover every tool the task declares."""
    names = [t.name for t in tools]
    problems = []
    missing = [n for n in task.allowed if n not in names]
    if missing:
        problems.append(
            f"the tools supplied do not include [{', '.join(missing)}], which tasks/{task.name}.yaml declares; "
            f"the agent would be given the wrong tools and its traces would measure nothing"
        )
    dupes = sorted({n for n in names if names.count(n) > 1})
    if dupes:
        problems.append(f"duplicate tool names: {', '.join(dupes)}")
    return problems


@dataclass
class BatchResult:
    batch_key: str
    files: list[Path]
    statuses: dict[str, int]


def run_batch(
    *,
    task: Task,
    selection: Selection,
    tools: ToolSource,
    model_factory: ModelFactory,
    graph_factory: GraphFactory,
    out_dir: Path,
    schema: dict[str, Any],
    max_turns: int = DEFAULT_MAX_TURNS,
    reply_tool: str = DEFAULT_REPLY_TOOL,
    log: Callable[[str], None] = lambda _m: None,
) -> BatchResult:
    """Every cell, trial-major (all variants' trial 1 first), like the MCP batch runner."""
    problems = check_tools(task, tools())
    if problems:
        raise RuntimeError("refusing to run:\n" + "\n".join(f"  - {p}" for p in problems))
    batch_key = str(uuid.uuid4())
    files: list[Path] = []
    statuses: dict[str, int] = {}
    cells = [(trial, v) for trial in range(1, selection.trials + 1) for v in selection.variants]
    for i, (trial, variant) in enumerate(cells, start=1):
        cell = CellInfo(task=task.name, tier=selection.tier, variant_id=variant.id, variant_text=variant.text, trial=trial)
        trace = run_cell(
            task=task,
            selection=selection,
            batch_key=batch_key,
            variant_id=variant.id,
            variant_text=variant.text,
            trial=trial,
            tools=tools(),
            model=model_factory(cell),
            graph_factory=graph_factory,
            max_turns=max_turns,
            reply_tool=reply_tool,
        )
        path = write_trace(out_dir / trace_filename(task.name, variant.id, trial), trace, schema)
        files.append(path)
        statuses[trace["status"]] = statuses.get(trace["status"], 0) + 1
        sandboxed = sum(1 for c in trace["tool_calls"] if c["is_sandboxed"])
        detail = f"{trace['error']['kind']} error: {trace['error']['message']}" if trace["error"] else f"{len(trace['tool_calls'])} tool call(s), {sandboxed} sandboxed"
        log(f"  [{i}/{len(cells)}] {variant.id} trial {trial}: {trace['status']} ({trace['stop_reason']}), {detail}, {trace['latency_ms']}ms")
    return BatchResult(batch_key=batch_key, files=files, statuses=statuses)
