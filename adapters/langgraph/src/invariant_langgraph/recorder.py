"""Record a LangGraph run's tool calls and model identity through LangChain callbacks.

Attach a TraceRecorder via the run config (`graph.ainvoke(input, config={"callbacks":
[recorder]})`); LangChain propagates it to every model and tool call the graph makes, so
the graph needs no changes to be recorded.

Each tool call becomes one record shaped like TECHNICAL_SPEC.md section 3 (minus run_id,
which the trace store assigns on ingest): sequence_index in the order calls started,
tool_name, args as the model sent them, the response, is_sandboxed, and the start
timestamp. Responses are normalised like the MCP proxy's normalizeToolResponse: a JSON
text is recorded as the parsed value, other text as the string, and a failed call as an
MCP-style error envelope {"isError": true, "content": [{"type": "text", "text": ...}]}.
"""
from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.messages import BaseMessage, SystemMessage, ToolMessage
from langchain_core.outputs import LLMResult

from .sandbox import SANDBOX_METADATA_KEY


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _jsonable(value: Any) -> Any:
    """A JSON-safe copy (anything json cannot encode becomes its str())."""
    return json.loads(json.dumps(value, default=str))


def error_envelope(text: str) -> dict[str, Any]:
    return {"isError": True, "content": [{"type": "text", "text": text}]}


def normalize_tool_response(output: Any) -> Any:
    if isinstance(output, ToolMessage):
        text = output.content if isinstance(output.content, str) else json.dumps(output.content, default=str)
        if output.status == "error":
            return error_envelope(text)
        output = output.content
    if isinstance(output, str):
        try:
            return json.loads(output)
        except ValueError:
            return output
    return _jsonable(output)


def _message_text(message: BaseMessage) -> str:
    content = message.content
    if isinstance(content, str):
        return content
    return "".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")


class TraceRecorder(BaseCallbackHandler):
    """Collects tool calls, model identity, system prompt and token usage for one run."""

    # A recording failure must fail the run, never silently drop a tool call.
    raise_error = True

    def __init__(self) -> None:
        self.tool_calls: list[dict[str, Any]] = []
        self._open: dict[UUID, dict[str, Any]] = {}
        self._lock = threading.Lock()
        #: Model ids as requested (from the model's invocation params), first seen first.
        self.model_names: list[str] = []
        #: Model ids the provider reported answering with, first seen first.
        self.model_versions: list[str] = []
        #: The system prompt of the first model call that had one.
        self.system_prompt: str | None = None
        self.model_responses = 0
        self.input_tokens = 0
        self.output_tokens = 0

    # ---------------------------------------------------------------- tools

    def on_tool_start(
        self,
        serialized: dict[str, Any],
        input_str: str,
        *,
        run_id: UUID,
        parent_run_id: UUID | None = None,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        inputs: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        name = (serialized or {}).get("name") or kwargs.get("name") or "(unnamed tool)"
        if isinstance(inputs, dict):
            args: Any = inputs
        else:
            try:
                args = json.loads(input_str)
            except ValueError:
                args = {"input": input_str}
            if not isinstance(args, dict):
                args = {"input": args}
        with self._lock:
            record = {
                "sequence_index": len(self.tool_calls),
                "tool_name": name,
                "args": _jsonable(args),
                "response": None,
                "is_sandboxed": bool((metadata or {}).get(SANDBOX_METADATA_KEY)),
                "timestamp": iso_now(),
            }
            self.tool_calls.append(record)
            self._open[run_id] = record

    def on_tool_end(self, output: Any, *, run_id: UUID, **kwargs: Any) -> None:
        with self._lock:
            record = self._open.pop(run_id, None)
        if record is not None:
            record["response"] = normalize_tool_response(output)

    def on_tool_error(self, error: BaseException, *, run_id: UUID, **kwargs: Any) -> None:
        with self._lock:
            record = self._open.pop(run_id, None)
        if record is not None:
            record["response"] = error_envelope(f"{type(error).__name__}: {error}")

    # ---------------------------------------------------------------- models

    def on_chat_model_start(
        self,
        serialized: dict[str, Any],
        messages: list[list[BaseMessage]],
        *,
        run_id: UUID,
        metadata: dict[str, Any] | None = None,
        invocation_params: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        params = invocation_params or {}
        requested = params.get("model") or params.get("model_name") or (metadata or {}).get("ls_model_name")
        with self._lock:
            if isinstance(requested, str) and requested and requested not in self.model_names:
                self.model_names.append(requested)
            if self.system_prompt is None:
                for message in messages[0] if messages else []:
                    if isinstance(message, SystemMessage):
                        self.system_prompt = _message_text(message)
                        break

    def on_llm_end(self, response: LLMResult, *, run_id: UUID, **kwargs: Any) -> None:
        with self._lock:
            for generations in response.generations:
                for generation in generations:
                    message = getattr(generation, "message", None)
                    if message is None:
                        continue
                    self.model_responses += 1
                    meta = getattr(message, "response_metadata", None) or {}
                    reported = meta.get("model_name") or meta.get("model")
                    if isinstance(reported, str) and reported and reported not in self.model_versions:
                        self.model_versions.append(reported)
                    usage = getattr(message, "usage_metadata", None) or {}
                    self.input_tokens += int(usage.get("input_tokens", 0) or 0)
                    self.output_tokens += int(usage.get("output_tokens", 0) or 0)
