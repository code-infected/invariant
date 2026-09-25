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
               (408/429/5xx, throttling, timeouts, connection errors), provider_rejected
               for any other 4xx (bad key, unknown model, invalid request), harness for
               everything else. See classify_error for how each provider's exceptions map. There is no retry: the cell is recorded
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

# packages/agent-driver DEFAULT_MODEL. A default, not a requirement: --model picks any provider.
DEFAULT_MODEL = "anthropic:claude-sonnet-4-5"
DEFAULT_MAX_TURNS = 12
DEFAULT_REPLY_TOOL = "reply_to_user"


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


def tool_schema(tools: Iterable[BaseTool]) -> list[dict[str, Any]]:
    """The tools as offered to the agent: name, description, input JSON schema, in order."""
    out = []
    for t in tools:
        fn = convert_to_openai_tool(t)["function"]
        out.append({"name": fn["name"], "description": fn.get("description", ""), "input_schema": fn.get("parameters", {})})
    return out


# Error classification. Each provider SDK surfaces failures differently; these are the
# shapes of the pinned versions (pyproject.toml):
#   openai / anthropic   APIStatusError subclasses with .status_code; APIConnectionError
#                        (and its APITimeoutError subclass) for transport failures
#   google-genai         errors.APIError with .code (HTTP status) and .status ("RESOURCE_EXHAUSTED");
#                        langchain-google-genai re-raises them as Google*Error, chained with `from`
#   botocore (Bedrock)   ClientError with response Error.Code ("ThrottlingException") and
#                        ResponseMetadata.HTTPStatusCode; EndpointConnectionError and
#                        ConnectTimeoutError/ReadTimeoutError for transport failures
#   langchain-core       ModelError subclasses (ModelRateLimitError, ModelAPIError, ...)
#                        that langchain-openai/-anthropic/-google-genai also raise
# The whole exception chain (__cause__/__context__) is searched, so a wrapped provider
# error is classified by what the provider said.

TRANSIENT_STATUSES = {"RESOURCE_EXHAUSTED", "UNAVAILABLE", "INTERNAL", "DEADLINE_EXCEEDED"}  # google.rpc codes
TRANSIENT_AWS_CODES = {
    "ThrottlingException",
    "TooManyRequestsException",
    "ServiceUnavailableException",
    "InternalServerException",
    "ModelNotReadyException",
    "ModelTimeoutException",
}
TRANSIENT_ERROR_NAMES = {
    # openai, anthropic (connection failures and timeouts)
    "APIConnectionError",
    "APITimeoutError",
    # botocore
    "EndpointConnectionError",
    "ConnectionClosedError",
    "ConnectTimeoutError",
    "ReadTimeoutError",
    # httpx / httpx2 (google-genai, and the openai/anthropic transports)
    "TransportError",
    "TimeoutException",
    "NetworkError",
    # langchain-core (the classes it marks is_retryable)
    "ModelConnectionError",
    "ModelTimeoutError",
    "ModelRateLimitError",
    "ModelAPIError",
}
REJECTED_ERROR_NAMES = {
    "ModelAuthenticationError",
    "ModelPermissionDeniedError",
    "ModelInvalidRequestError",
    "ModelNotFoundError",
}


def _chain(err: BaseException) -> list[BaseException]:
    out: list[BaseException] = []
    cur: BaseException | None = err
    while cur is not None and cur not in out and len(out) < 8:
        out.append(cur)
        cur = cur.__cause__ or cur.__context__
    return out


def _http_status(err: BaseException) -> int | None:
    status = getattr(err, "status_code", None)
    if isinstance(status, int):
        return status
    code = getattr(err, "code", None)  # google.genai.errors.APIError
    if isinstance(code, int) and 100 <= code < 600:
        return code
    response = getattr(err, "response", None)
    if isinstance(response, dict):  # botocore ClientError
        status = response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        return status if isinstance(status, int) else None
    status = getattr(response, "status_code", None)
    return status if isinstance(status, int) else None


def _names(err: BaseException) -> set[str]:
    return {cls.__name__ for cls in type(err).__mro__}


def classify_error(err: BaseException) -> dict[str, Any]:
    chain = _chain(err)
    status = next((s for s in map(_http_status, chain) if s is not None), None)
    kind: str | None = None
    for e in chain:
        s = _http_status(e)
        response = getattr(e, "response", None)
        aws_code = response.get("Error", {}).get("Code") if isinstance(response, dict) else None
        rpc_status = getattr(e, "status", None)
        names = _names(e)
        if aws_code in TRANSIENT_AWS_CODES or (isinstance(rpc_status, str) and rpc_status in TRANSIENT_STATUSES):
            kind = "provider"
        elif s is not None and s >= 400:
            kind = "provider" if s in (408, 429) or s >= 500 else "provider_rejected"
        elif names & TRANSIENT_ERROR_NAMES:
            kind = "provider"
        elif names & REJECTED_ERROR_NAMES:
            kind = "provider_rejected"
        if kind is not None:
            break
    error: dict[str, Any] = {"kind": kind or "harness", "message": f"{type(err).__name__}: {err}"}
    if status is not None:
        error["http_status"] = status
    return error


FRAMEWORK_PACKAGES = ("langgraph", "langchain-core")


def framework_versions(provider_package: str | None = None) -> dict[str, str]:
    out = {}
    for pkg in (*FRAMEWORK_PACKAGES, *((provider_package,) if provider_package else ())):
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
    target: Any = None,
    on_sampling_params: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    """Run one cell and return its trace (not yet written).

    `target` (a providers.ModelTarget) is what real mode asked for: its model id is the
    fingerprint's model_name, and its provider and endpoint are recorded next to it. With
    --model-factory there is no target, the requested id is read from the model's own
    invocation params, and provider/endpoint are left out rather than guessed.
    """
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
        if target is not None:
            requested = target.model
        else:
            requested = recorder.model_names[0] if recorder.model_names else "(not reported by the model object)"
        fingerprint = {
            "model_name": requested,
            "model_version": recorder.model_versions[0] if recorder.model_versions else "(not reported by the API)",
            "system_prompt": recorder.system_prompt,
            "tool_schema": tool_schema(offered),
        }
        if target is not None:
            fingerprint["provider"] = target.provider
            fingerprint["endpoint"] = target.endpoint

    if on_sampling_params is not None and recorder.sampling_params is not None:
        on_sampling_params(recorder.sampling_params)
    return {
        "format": FORMAT,
        "adapter": {"name": ADAPTER_NAME, "version": __version__, "framework": framework_versions(target.package if target is not None else None)},
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
        **({"params_sent": recorder.sampling_params} if recorder.sampling_params else {}),
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
    target: Any = None,
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
            target=target,
            on_sampling_params=(lambda p: log(f"  sampling params in the first model call: {p or 'none'}")) if i == 1 else None,
        )
        path = write_trace(out_dir / trace_filename(task.name, variant.id, trial), trace, schema)
        files.append(path)
        statuses[trace["status"]] = statuses.get(trace["status"], 0) + 1
        sandboxed = sum(1 for c in trace["tool_calls"] if c["is_sandboxed"])
        detail = f"{trace['error']['kind']} error: {trace['error']['message']}" if trace["error"] else f"{len(trace['tool_calls'])} tool call(s), {sandboxed} sandboxed"
        log(f"  [{i}/{len(cells)}] {variant.id} trial {trial}: {trace['status']} ({trace['stop_reason']}), {detail}, {trace['latency_ms']}ms")
    return BatchResult(batch_key=batch_key, files=files, statuses=statuses)
