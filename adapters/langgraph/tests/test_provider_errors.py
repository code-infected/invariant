"""Provider failures: exactly one request (no hidden retries), classified per provider.

Each case drives the real LangChain integration and the real provider SDK against the
SYNTHETIC local server (tests/fake_providers.py) answering with that provider's error
shape, so what is classified is the exception the SDK really raises.
"""
from __future__ import annotations

import asyncio

import pytest
from langchain_core.messages import HumanMessage

from invariant_langgraph.driver import classify_error
from invariant_langgraph.providers import build_model_factory

ENV = {
    "ANTHROPIC_API_KEY": "k",
    "OPENAI_API_KEY": "k",
    "GEMINI_API_KEY": "k",
    "AZURE_OPENAI_API_KEY": "k",
    "OPENAI_API_VERSION": "2024-10-21",
    "AWS_REGION": "us-east-1",
    "AWS_ACCESS_KEY_ID": "AKIDEXAMPLE",
    "AWS_SECRET_ACCESS_KEY": "secret",
}

REFS = {
    "openai": ("openai:gpt-4.1", "/v1"),
    "azure": ("azure:dep", ""),
    "ollama": ("ollama:qwen2.5:3b", "/v1"),
    "anthropic": ("anthropic:claude-sonnet-4-5", ""),
    "gemini": ("gemini:gemini-2.5-flash", ""),
    "bedrock": ("bedrock:amazon.nova-lite-v1:0", ""),
}

CASES = [
    # provider, HTTP status, provider error code, expected kind
    ("openai", 429, "rate_limit_exceeded", "provider"),
    ("openai", 500, "server_error", "provider"),
    ("openai", 401, "invalid_api_key", "provider_rejected"),
    ("openai", 404, "model_not_found", "provider_rejected"),
    ("azure", 429, "429", "provider"),
    ("azure", 400, "content_filter", "provider_rejected"),
    ("ollama", 503, "unavailable", "provider"),
    ("ollama", 404, "not_found", "provider_rejected"),
    ("anthropic", 429, "rate_limit_error", "provider"),
    ("anthropic", 529, "overloaded_error", "provider"),
    ("anthropic", 401, "authentication_error", "provider_rejected"),
    ("anthropic", 400, "invalid_request_error", "provider_rejected"),
    ("gemini", 429, "RESOURCE_EXHAUSTED", "provider"),
    ("gemini", 503, "UNAVAILABLE", "provider"),
    ("gemini", 400, "INVALID_ARGUMENT", "provider_rejected"),
    ("gemini", 403, "PERMISSION_DENIED", "provider_rejected"),
    ("bedrock", 429, "ThrottlingException", "provider"),
    ("bedrock", 503, "ServiceUnavailableException", "provider"),
    ("bedrock", 500, "InternalServerException", "provider"),
    ("bedrock", 400, "ValidationException", "provider_rejected"),
    ("bedrock", 403, "AccessDeniedException", "provider_rejected"),
]


@pytest.fixture()
def aws_env(clean_env):
    for k, v in ENV.items():
        if k.startswith("AWS_"):
            clean_env.setenv(k, v)


def _call(fake, provider):
    ref, path = REFS[provider]
    factory, _ = build_model_factory(ref, base_url=fake.url + path, env=ENV)
    with pytest.raises(Exception) as err:
        asyncio.run(factory(None).ainvoke([HumanMessage(content="hi")]))
    return err.value


@pytest.mark.parametrize("provider, status, code, kind", CASES)
def test_one_request_then_the_error_is_classified(fake, aws_env, provider, status, code, kind):
    fake.fail = (status, code)
    err = _call(fake, provider)
    assert len(fake.requests) == 1, f"{provider} retried a {status}: {len(fake.requests)} requests"
    error = classify_error(err)
    assert error["kind"] == kind, error
    assert error["http_status"] == status


@pytest.mark.parametrize("provider", sorted(REFS))
def test_an_unreachable_endpoint_is_a_provider_error(aws_env, provider):
    class Nowhere:
        url = "http://127.0.0.1:9"  # discard port: connection refused

    err = _call(Nowhere, provider)
    error = classify_error(err)
    assert error["kind"] == "provider", error
    assert "http_status" not in error


def test_a_harness_bug_is_not_blamed_on_the_provider():
    assert classify_error(KeyError("messages"))["kind"] == "harness"
    assert classify_error(ValueError("bad graph"))["kind"] == "harness"


def test_a_wrapped_provider_error_is_classified_by_its_cause():
    from botocore.exceptions import ClientError

    throttled = ClientError({"Error": {"Code": "ThrottlingException", "Message": "slow down"}}, "Converse")
    try:
        try:
            raise throttled
        except ClientError as inner:
            raise RuntimeError("tool node failed") from inner
    except RuntimeError as outer:
        error = classify_error(outer)
    # A ClientError built without ResponseMetadata still classifies by its AWS error code.
    assert error["kind"] == "provider"
    assert error["message"] == "RuntimeError: tool node failed"


def test_google_status_names_classify_without_an_http_status():
    from google.genai import errors

    exhausted = errors.ClientError(429, {"error": {"code": 429, "message": "quota", "status": "RESOURCE_EXHAUSTED"}})
    assert classify_error(exhausted)["kind"] == "provider"
    assert classify_error(errors.ServerError(500, {"error": {"code": 500, "message": "x", "status": "INTERNAL"}}))["kind"] == "provider"
    denied = errors.ClientError(403, {"error": {"code": 403, "message": "no", "status": "PERMISSION_DENIED"}})
    assert classify_error(denied)["kind"] == "provider_rejected"
