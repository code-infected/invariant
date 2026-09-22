"""Real mode end to end: `invariant-langgraph run --model provider:model` against the
SYNTHETIC local server (tests/fake_providers.py), through the real example graph, the real
LangChain integration and the real provider SDK over HTTP. The model's turns are scripted
by the fake server, so nothing here is a finding about a model; it proves the plumbing:
requests leave in each provider's wire format, tool calls come back and are recorded, and
the trace file carries the provider, endpoint and reported model."""
from __future__ import annotations

import json

import pytest

from invariant_langgraph.cli import main
from invariant_langgraph.trace_file import validation_errors
from tests.fake_providers import REPORTED_MODEL

ORDER = {"order_id": "1234"}
REFUND_SCRIPT = [
    {"tool": "lookup_order", "args": ORDER},
    {"tool": "check_refund_history", "args": ORDER},
    {"tool": "process_refund", "args": {"order_id": "1234", "amount": 42}},
    {"tool": "reply_to_user", "args": {"message": "Refunded $42.00 for order 1234."}},
]
BASE = [
    "run", "--task", "refund-duplicate-check", "--tier", "smoke",
    "--graph", "invariant_langgraph.examples.refund:build_graph",
    "--tools", "invariant_langgraph.examples.refund:make_tools",
]


def _run(repo_root, out, *extra):
    return main([*BASE, "--out", str(out), "--repo-root", str(repo_root), *extra])


def _traces(out):
    return [json.loads(p.read_text()) for p in sorted(out.glob("*.json"))]


def test_a_full_smoke_tier_through_an_openai_compatible_server(fake, clean_env, repo_root, schema, tmp_path, capsys):
    fake.steps = REFUND_SCRIPT
    out = tmp_path / "traces"
    code = _run(repo_root, out, "--model", "openai-compatible:fake-model", "--base-url", f"{fake.url}/v1")
    assert code == 0, capsys.readouterr().err
    traces = _traces(out)
    # tasks/refund-duplicate-check.yaml smoke tier: 2 variants x 2 trials.
    assert sorted((t["variant"]["id"], t["trial"]) for t in traces) == [("v1", 1), ("v1", 2), ("v2", 1), ("v2", 2)]
    for t in traces:
        assert validation_errors(t, schema) == []
        assert t["status"] == "ok" and t["stop_reason"] == "reply_to_user"
        assert t["final_output"] == "Refunded $42.00 for order 1234."
        assert [c["tool_name"] for c in t["tool_calls"]] == [s["tool"] for s in REFUND_SCRIPT]
        assert [c["is_sandboxed"] for c in t["tool_calls"]] == [False, False, True, False]
        assert t["tool_calls"][1]["response"]["already_refunded"] is True
        fp = t["fingerprint"]
        assert fp["model_name"] == "fake-model"
        assert fp["model_version"] == REPORTED_MODEL
        assert fp["provider"] == "openai-compatible"
        assert fp["endpoint"] == fake.host
        assert [x["name"] for x in fp["tool_schema"]] == ["lookup_order", "check_refund_history", "process_refund", "reply_to_user"]
        assert "langchain-openai" in t["adapter"]["framework"]
        assert t["usage"] == {"input_tokens": 44, "output_tokens": 28}

    # 4 cells x 4 model turns, all in OpenAI's wire format with the tools offered.
    assert len(fake.requests) == 16
    first = fake.requests[0]
    assert first["path"] == "/v1/chat/completions"
    assert first["body"]["model"] == "fake-model"
    assert [t["function"]["name"] for t in first["body"]["tools"]] == [s["tool"] for s in REFUND_SCRIPT]
    # No sampling params the user did not ask for, and no borrowed key.
    assert not {"temperature", "top_p", "max_tokens", "max_completion_tokens"} & set(first["body"])
    assert first["headers"]["authorization"] == "Bearer no-key"
    err = capsys.readouterr().err
    assert "model: openai-compatible:fake-model at " + fake.host + "; params sent: none (provider defaults)" in err
    assert "sampling params in the first model call: none" in err


@pytest.mark.parametrize(
    "ref, path, reported, request_path",
    [
        ("anthropic:claude-sonnet-4-5", "", REPORTED_MODEL, "/v1/messages"),
        ("openai:gpt-4.1", "/v1", REPORTED_MODEL, "/v1/chat/completions"),
        ("azure:my-deployment", "", REPORTED_MODEL, "/openai/deployments/my-deployment/chat/completions?api-version=2024-10-21"),
        ("gemini:gemini-2.5-flash", "", REPORTED_MODEL, "/v1beta/models/gemini-2.5-flash:generateContent"),
        # The Converse API reports no model id, and langchain-aws's echo of the requested one is not taken for one.
        ("bedrock:amazon.nova-lite-v1:0", "", "(not reported by the API)", "/model/amazon.nova-lite-v1%3A0/converse"),
        ("ollama:qwen2.5:3b", "/v1", REPORTED_MODEL, "/v1/chat/completions"),
        ("groq:llama-3.3-70b-versatile", "/openai/v1", REPORTED_MODEL, "/openai/v1/chat/completions"),
    ],
)
def test_one_trial_per_provider(fake, clean_env, repo_root, schema, tmp_path, ref, path, reported, request_path):
    for k, v in {
        "ANTHROPIC_API_KEY": "k", "OPENAI_API_KEY": "k", "GEMINI_API_KEY": "k", "GROQ_API_KEY": "k",
        "AZURE_OPENAI_API_KEY": "k", "OPENAI_API_VERSION": "2024-10-21",
        "AWS_REGION": "us-east-1", "AWS_ACCESS_KEY_ID": "AKIDEXAMPLE", "AWS_SECRET_ACCESS_KEY": "secret",
    }.items():
        clean_env.setenv(k, v)
    fake.steps = REFUND_SCRIPT
    out = tmp_path / "traces"
    code = _run(repo_root, out, "--variants", "v1", "--trials", "1", "--model", ref, "--base-url", fake.url + path)
    assert code == 0
    [trace] = _traces(out)
    assert validation_errors(trace, schema) == []
    assert trace["status"] == "ok" and trace["stop_reason"] == "reply_to_user"
    assert [c["tool_name"] for c in trace["tool_calls"]] == [s["tool"] for s in REFUND_SCRIPT]
    assert trace["tool_calls"][2]["is_sandboxed"] is True
    fp = trace["fingerprint"]
    assert fp["model_name"] == ref.partition(":")[2]
    assert fp["model_version"] == reported
    assert fp["provider"] == ref.partition(":")[0] and fp["endpoint"] == fake.host
    assert fake.requests[0]["path"] == request_path
    assert len(fake.requests) == len(REFUND_SCRIPT)


def test_an_openai_compatible_server_that_omits_the_model_field(fake, clean_env, repo_root, tmp_path):
    """Nothing reported means "(not reported by the API)", never the requested id echoed
    back. (langchain-openai's llm_output does fall back to the requested id; the recorder
    reads the message's response_metadata, which does not.)"""
    fake.steps = [{"tool": "reply_to_user", "args": {"message": "hi"}}]
    fake.reported_model = None
    out = tmp_path / "traces"
    assert _run(repo_root, out, "--variants", "v1", "--trials", "1", "--model", "vllm:my-model", "--base-url", f"{fake.url}/v1") == 0
    [trace] = _traces(out)
    assert trace["fingerprint"]["model_name"] == "my-model"
    assert trace["fingerprint"]["model_version"] == "(not reported by the API)"


def test_params_are_sent_only_when_passed_and_logged(fake, clean_env, repo_root, tmp_path, capsys):
    fake.steps = [{"tool": "reply_to_user", "args": {"message": "hi"}}]
    out = tmp_path / "traces"
    code = _run(
        repo_root, out, "--variants", "v1", "--trials", "1", "--model", "ollama:qwen2.5:3b",
        "--base-url", f"{fake.url}/v1", "--param", "temperature=0", "--param", "seed=7",
    )
    assert code == 0
    body = fake.requests[0]["body"]
    assert body["temperature"] == 0 and body["seed"] == 7
    err = capsys.readouterr().err
    assert "params sent: temperature=0, seed=7" in err
    assert "sampling params in the first model call: {'temperature': 0.0, 'seed': 7}" in err


def test_anthropic_sends_its_required_max_tokens_and_the_log_says_so(fake, clean_env, repo_root, tmp_path, capsys):
    clean_env.setenv("ANTHROPIC_API_KEY", "k")
    fake.steps = [{"tool": "reply_to_user", "args": {"message": "hi"}}]
    out = tmp_path / "traces"
    assert _run(repo_root, out, "--variants", "v1", "--trials", "1", "--model", "anthropic:claude-sonnet-4-5", "--base-url", fake.url) == 0
    body = fake.requests[0]["body"]
    assert "temperature" not in body and isinstance(body["max_tokens"], int)
    assert f"sampling params in the first model call: {{'max_tokens': {body['max_tokens']}}}" in capsys.readouterr().err


def test_a_provider_failure_is_that_cells_infra_error(fake, clean_env, repo_root, schema, tmp_path, capsys):
    fake.fail = (429, "rate_limit_exceeded")
    out = tmp_path / "traces"
    code = _run(repo_root, out, "--variants", "v1", "--trials", "2", "--model", "openai-compatible:m", "--base-url", f"{fake.url}/v1")
    assert code == 1
    traces = _traces(out)
    assert len(traces) == 2 and len(fake.requests) == 2  # one request per cell, no retries
    for t in traces:
        assert validation_errors(t, schema) == []
        assert t["status"] == "infra_error" and t["stop_reason"] == "error"
        assert t["error"]["kind"] == "provider" and t["error"]["http_status"] == 429
        assert t["fingerprint"] is None  # no model response, no guessed fingerprint
