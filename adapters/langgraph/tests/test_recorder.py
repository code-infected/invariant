"""TraceRecorder, attached only through the run config of a real LangGraph graph."""
from __future__ import annotations

from langchain_core.tools import StructuredTool

from invariant_langgraph.driver import run_cell
from invariant_langgraph.examples.refund import SYSTEM_PROMPT, build_graph, make_tools
from invariant_langgraph.recorder import normalize_tool_response
from invariant_langgraph.scripted import SCRIPTED_MODEL_NAME, SCRIPTED_MODEL_VERSION, ScriptedChatModel

ORDER = {"order_id": "1234"}


def _run(task, selection, steps, tools=None, **kw):
    return run_cell(
        task=task,
        selection=selection,
        batch_key="test-batch",
        variant_id="v1",
        variant_text=task.variants[0].text,
        trial=1,
        tools=tools if tools is not None else make_tools(),
        model=ScriptedChatModel(steps=steps),
        graph_factory=build_graph,
        **kw,
    )


def test_records_every_tool_call_in_order_with_args_and_parsed_responses(task, selection):
    trace = _run(
        task,
        selection,
        [
            {"tool": "lookup_order", "args": ORDER},
            {"tool": "check_refund_history", "args": ORDER},
            {"tool": "reply_to_user", "args": {"message": "Already refunded, no second refund."}},
        ],
    )
    calls = trace["tool_calls"]
    assert [c["sequence_index"] for c in calls] == [0, 1, 2]
    assert [c["tool_name"] for c in calls] == ["lookup_order", "check_refund_history", "reply_to_user"]
    assert calls[0]["args"] == ORDER
    # JSON text responses are recorded as the parsed payload, like the MCP proxy does.
    assert calls[1]["response"]["already_refunded"] is True
    assert calls[2]["response"] == {"status": "delivered", "characters": 35}
    assert all(c["is_sandboxed"] is False for c in calls)
    assert all(c["timestamp"].endswith("Z") for c in calls)
    assert calls[0]["timestamp"] <= calls[1]["timestamp"] <= calls[2]["timestamp"]
    assert trace["status"] == "ok" and trace["stop_reason"] == "reply_to_user"
    assert trace["final_output"] == "Already refunded, no second refund."


def test_records_model_identity_system_prompt_and_tool_schema(task, selection):
    trace = _run(task, selection, [{"tool": "reply_to_user", "args": {"message": "hi"}}])
    fp = trace["fingerprint"]
    assert fp["model_name"] == SCRIPTED_MODEL_NAME
    assert fp["model_version"] == SCRIPTED_MODEL_VERSION
    assert fp["system_prompt"] == SYSTEM_PROMPT
    assert [t["name"] for t in fp["tool_schema"]] == ["lookup_order", "check_refund_history", "process_refund", "reply_to_user"]
    assert fp["tool_schema"][0]["input_schema"]["required"] == ["order_id"]


def test_invalid_arguments_are_recorded_as_an_error_envelope_and_the_run_continues(task, selection):
    trace = _run(
        task,
        selection,
        [{"tool": "lookup_order", "args": {"wrong": 1}}, {"tool": "reply_to_user", "args": {"message": "sorry"}}],
    )
    first = trace["tool_calls"][0]
    assert first["args"] == {"wrong": 1}
    assert first["response"]["isError"] is True
    assert "order_id" in first["response"]["content"][0]["text"]
    assert trace["status"] == "ok"


def test_a_tool_that_raises_is_recorded_and_the_cell_is_an_infra_error(task, selection):
    def broken(order_id: str) -> str:
        raise RuntimeError("backend down")

    tools = make_tools()
    tools[0] = StructuredTool.from_function(broken, name="lookup_order", description="Look up an order.")
    trace = _run(task, selection, [{"tool": "lookup_order", "args": ORDER}], tools=tools)
    assert trace["tool_calls"][0]["response"] == {
        "isError": True,
        "content": [{"type": "text", "text": "RuntimeError: backend down"}],
    }
    assert trace["status"] == "infra_error"
    assert trace["error"] == {"kind": "harness", "message": "RuntimeError: backend down"}
    assert trace["final_output"] is None


def test_prose_answer_without_the_reply_tool_is_end_turn(task, selection):
    trace = _run(task, selection, [{"tool": "lookup_order", "args": ORDER}, {"text": "It was already refunded."}])
    assert trace["status"] == "ok" and trace["stop_reason"] == "end_turn"
    assert trace["final_output"] == "It was already refunded."


def test_recursion_limit_is_a_max_turns_timeout(task, selection):
    trace = _run(task, selection, [{"tool": "lookup_order", "args": ORDER}] * 50, max_turns=3)
    assert trace["status"] == "timeout" and trace["stop_reason"] == "max_turns"
    assert trace["error"] is None


def test_wall_clock_is_enforced(task, selection):
    import time

    def slow(order_id: str) -> str:
        time.sleep(1.5)
        return "{}"

    tools = make_tools()
    tools[0] = StructuredTool.from_function(slow, name="lookup_order", description="Look up an order.")
    trace = _run(task, selection, [{"tool": "lookup_order", "args": ORDER}, {"text": "done"}], tools=tools, timeout_s=0.3)
    assert trace["status"] == "timeout" and trace["stop_reason"] == "wall_clock_timeout"
    assert trace["final_output"] is None


def test_normalize_matches_the_mcp_proxy_rules():
    assert normalize_tool_response('{"a": 1}') == {"a": 1}
    assert normalize_tool_response("plain text") == "plain text"
    assert normalize_tool_response({"x": [1, 2]}) == {"x": [1, 2]}
