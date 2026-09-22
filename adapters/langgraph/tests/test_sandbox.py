"""Dangerous-tool sandboxing: the real function must never run, and the recording must say so."""
from __future__ import annotations

import dataclasses
import json

from langchain_core.utils.function_calling import convert_to_openai_tool

from invariant_langgraph.driver import run_cell
from invariant_langgraph.examples.refund import ToyBackend, build_graph
from invariant_langgraph.sandbox import is_sandboxed_tool, sandbox_tools
from invariant_langgraph.scripted import ScriptedChatModel

REFUND = {"order_id": "1234", "amount": 42, "request_id": "req-1"}
STEPS = [
    {"tool": "lookup_order", "args": {"order_id": "1234"}},
    {"tool": "process_refund", "args": REFUND},
    {"tool": "reply_to_user", "args": {"message": "Refunded."}},
]


def _run(task, selection, backend):
    return run_cell(
        task=task,
        selection=selection,
        batch_key="k",
        variant_id="v1",
        variant_text=task.variants[0].text,
        trial=1,
        tools=backend.tools(),
        model=ScriptedChatModel(steps=STEPS),
        graph_factory=build_graph,
    )


def test_dangerous_call_gets_the_sandbox_response_and_never_reaches_the_real_tool(task, selection):
    backend = ToyBackend()
    trace = _run(task, selection, backend)
    refund = trace["tool_calls"][1]
    assert refund["tool_name"] == "process_refund"
    assert refund["is_sandboxed"] is True
    assert refund["args"] == REFUND
    assert refund["response"] == json.loads(task.dangerous["process_refund"])
    # The proof: the real process_refund would have logged a side effect and added a refund.
    assert [e["tool"] for e in backend.side_effects] == ["reply_to_user"]
    assert len(backend.refunds["1234"]) == 1
    # Only the dangerous tool is sandboxed.
    assert [c["is_sandboxed"] for c in trace["tool_calls"]] == [False, True, False]


def test_control_without_sandboxing_the_real_tool_runs_and_is_recorded_unsandboxed(task, selection):
    unsandboxed = dataclasses.replace(task, spec={**task.spec, "tools": {**task.spec["tools"], "dangerous": []}})
    backend = ToyBackend()
    trace = _run(unsandboxed, selection, backend)
    refund = trace["tool_calls"][1]
    assert refund["is_sandboxed"] is False
    assert refund["response"]["status"] == "refunded"
    assert [e["tool"] for e in backend.side_effects] == ["process_refund", "reply_to_user"]


def test_the_wrapper_offers_the_model_the_identical_tool_definition():
    tools = ToyBackend().tools()
    wrapped = sandbox_tools(tools, {"process_refund": '{"status": "sandboxed"}'})
    assert [convert_to_openai_tool(t) for t in wrapped] == [convert_to_openai_tool(t) for t in tools]
    assert [is_sandboxed_tool(t) for t in wrapped] == [False, False, True, False]
    assert wrapped[3] is tools[3]  # non-dangerous tools pass through untouched


def test_the_wrapper_still_validates_arguments_like_the_real_tool():
    backend = ToyBackend()
    [wrapped] = sandbox_tools([backend.tools()[2]], {"process_refund": "SANDBOXED"})
    assert wrapped.invoke({"order_id": "1234", "amount": 1}) == "SANDBOXED"
    try:
        wrapped.invoke({"order_id": "1234"})
    except Exception as err:  # pydantic ValidationError
        assert "amount" in str(err)
    else:
        raise AssertionError("missing amount should fail validation")
    assert backend.side_effects == []
