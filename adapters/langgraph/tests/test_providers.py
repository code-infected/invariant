"""--model provider:model: parsing, the class each provider maps to, and the refusals."""
from __future__ import annotations

import sys

import pytest

from invariant_langgraph.providers import (
    NO_KEY_PLACEHOLDER,
    PRESETS,
    PROVIDERS,
    ProviderError,
    build_model_factory,
    endpoint_host,
    parse_model_ref,
    parse_params,
)

KEYS = {
    "ANTHROPIC_API_KEY": "sk-ant-test",
    "OPENAI_API_KEY": "sk-openai-test",
    "GEMINI_API_KEY": "gemini-test",
    "AZURE_OPENAI_API_KEY": "azure-test",
    "AZURE_OPENAI_ENDPOINT": "https://my-resource.openai.azure.com",
    "OPENAI_API_VERSION": "2024-10-21",
    "AWS_REGION": "eu-west-1",
    "AWS_ACCESS_KEY_ID": "AKIDEXAMPLE",
    "AWS_SECRET_ACCESS_KEY": "secret",
    "OPENROUTER_API_KEY": "or-test",
    "GROQ_API_KEY": "groq-test",
    "TOGETHER_API_KEY": "together-test",
    "DEEPSEEK_API_KEY": "deepseek-test",
    "MISTRAL_API_KEY": "mistral-test",
    "XAI_API_KEY": "xai-test",
    "FIREWORKS_API_KEY": "fireworks-test",
}


def build(ref, env=None, **kw):
    factory, target = build_model_factory(ref, env=KEYS if env is None else env, **kw)
    return factory(None), target


def secret(value):
    return value.get_secret_value() if hasattr(value, "get_secret_value") else value


# ---------------------------------------------------------------- parsing


def test_the_reference_splits_on_the_first_colon_only():
    ref = parse_model_ref("ollama:qwen2.5:3b")
    assert (ref.provider, ref.model) == ("ollama", "qwen2.5:3b")
    ref = parse_model_ref("bedrock:anthropic.claude-3-5-haiku-20241022-v1:0")
    assert (ref.provider, ref.model) == ("bedrock", "anthropic.claude-3-5-haiku-20241022-v1:0")


@pytest.mark.parametrize("bad", ["claude-sonnet-4-5", "openai:", ":gpt-4.1", ""])
def test_a_reference_without_provider_and_model_is_refused(bad):
    with pytest.raises(ProviderError, match="provider:model"):
        parse_model_ref(bad)


def test_an_unknown_provider_is_refused_with_the_list():
    with pytest.raises(ProviderError, match="unknown provider 'cohere'.*openai-compatible"):
        parse_model_ref("cohere:command-r")


def test_provider_names_match_the_typescript_cli():
    assert set(PROVIDERS) == {
        "anthropic", "openai", "azure", "gemini", "bedrock", "openai-compatible",
        "openrouter", "groq", "together", "deepseek", "mistral", "xai", "fireworks", "ollama", "lmstudio", "vllm",
    }


def test_params_parse_as_json_values_else_strings():
    assert parse_params(["temperature=0", "top_p=0.9", "stop=[\"x\"]", "reasoning_effort=low", "seed=7"]) == {
        "temperature": 0, "top_p": 0.9, "stop": ["x"], "reasoning_effort": "low", "seed": 7,
    }
    assert parse_params(None) == {}
    with pytest.raises(ProviderError, match="key=value"):
        parse_params(["temperature"])
    with pytest.raises(ProviderError, match="set by the adapter"):
        parse_params(["max_retries=3"])


@pytest.mark.parametrize(
    "url, host",
    [
        ("https://api.openai.com/v1", "api.openai.com"),
        ("http://localhost:11434/v1", "localhost:11434"),
        ("https://user:hunter2@proxy.example.com:8443/v1?key=abc", "proxy.example.com:8443"),
        ("http://[::1]:8000/v1", "[::1]:8000"),
        ("my-resource.openai.azure.com", "my-resource.openai.azure.com"),
        (None, None),
    ],
)
def test_the_endpoint_is_host_and_port_only(url, host):
    assert endpoint_host(url) == host


# ---------------------------------------------------------------- mapping


def test_anthropic():
    model, target = build("anthropic:claude-sonnet-4-5")
    assert type(model).__name__ == "ChatAnthropic"
    assert model.model == "claude-sonnet-4-5" and model.max_retries == 0
    assert secret(model.anthropic_api_key) == "sk-ant-test"
    assert model.anthropic_api_url == "https://api.anthropic.com"
    assert (target.provider, target.endpoint, target.package) == ("anthropic", "api.anthropic.com", "langchain-anthropic")


def test_openai():
    model, target = build("openai:gpt-4.1")
    assert type(model).__name__ == "ChatOpenAI"
    assert model.model_name == "gpt-4.1" and model.max_retries == 0
    assert model.root_client.max_retries == 0
    assert secret(model.openai_api_key) == "sk-openai-test"
    assert model.openai_api_base == "https://api.openai.com/v1"
    assert model.temperature is None
    assert (target.provider, target.endpoint) == ("openai", "api.openai.com")


def test_azure_uses_the_deployment_name_endpoint_and_api_version():
    model, target = build("azure:my-gpt4o-deployment")
    assert type(model).__name__ == "AzureChatOpenAI"
    assert model.deployment_name == "my-gpt4o-deployment"
    assert model.azure_endpoint == "https://my-resource.openai.azure.com"
    assert model.openai_api_version == "2024-10-21"
    assert secret(model.openai_api_key) == "azure-test"
    assert model.max_retries == 0 and model.root_client.max_retries == 0
    assert (target.provider, target.model, target.endpoint) == ("azure", "my-gpt4o-deployment", "my-resource.openai.azure.com")


def test_gemini_disables_retries_with_one_attempt_and_sends_no_temperature():
    model, target = build("gemini:gemini-2.5-flash")
    assert type(model).__name__ == "ChatGoogleGenerativeAI"
    assert model.model.endswith("gemini-2.5-flash")
    # One attempt in total: the Google SDK reads 0 as "default retries".
    assert model.max_retries == 1
    assert model.temperature is None
    assert model.vertexai is False
    assert secret(model.google_api_key) == "gemini-test"
    assert (target.provider, target.endpoint) == ("gemini", "generativelanguage.googleapis.com")


def test_gemini_accepts_google_api_key_too():
    env = {k: v for k, v in KEYS.items() if k != "GEMINI_API_KEY"} | {"GOOGLE_API_KEY": "google-test"}
    model, _ = build("gemini:gemini-2.5-flash", env=env)
    assert secret(model.google_api_key) == "google-test"


def test_gemini_temperature_is_sent_only_when_passed():
    model, target = build("gemini:gemini-2.5-flash", params={"temperature": 0.2})
    assert model.temperature == 0.2 and target.params == {"temperature": 0.2}


def test_bedrock_makes_one_attempt_in_the_configured_region():
    model, target = build("bedrock:anthropic.claude-3-5-haiku-20241022-v1:0")
    assert type(model).__name__ == "ChatBedrockConverse"
    assert model.model_id == "anthropic.claude-3-5-haiku-20241022-v1:0"
    assert model.region_name == "eu-west-1"
    assert model.client.meta.config.retries["total_max_attempts"] == 1
    assert model.client.meta.endpoint_url == "https://bedrock-runtime.eu-west-1.amazonaws.com"
    assert (target.provider, target.endpoint, target.package) == ("bedrock", "bedrock-runtime.eu-west-1.amazonaws.com", "langchain-aws")


def test_bedrock_accepts_a_bedrock_api_key_instead_of_aws_credentials():
    env = {"AWS_REGION": "us-east-1", "AWS_BEARER_TOKEN_BEDROCK": "bedrock-key"}
    model, _ = build("bedrock:amazon.nova-lite-v1:0", env=env)
    assert secret(model.bedrock_api_key) == "bedrock-key"


@pytest.mark.parametrize("provider", sorted(PRESETS))
def test_every_openai_compatible_preset(provider):
    preset = PRESETS[provider]
    model, target = build(f"{provider}:some/model:tag")
    assert type(model).__name__ == "ChatOpenAI"
    assert model.model_name == "some/model:tag"
    assert model.openai_api_base == preset.base_url
    assert model.max_retries == 0 and model.root_client.max_retries == 0
    expected_key = KEYS[preset.key_env] if preset.key_env in KEYS else NO_KEY_PLACEHOLDER
    assert secret(model.openai_api_key) == expected_key
    assert target.provider == provider and target.endpoint == endpoint_host(preset.base_url)


def test_preset_urls_and_key_envs():
    """Checked against each provider's documentation (2026-09); a change here is deliberate."""
    assert {p: (v.base_url, v.key_env) for p, v in PRESETS.items()} == {
        "openrouter": ("https://openrouter.ai/api/v1", "OPENROUTER_API_KEY"),
        "groq": ("https://api.groq.com/openai/v1", "GROQ_API_KEY"),
        "together": ("https://api.together.ai/v1", "TOGETHER_API_KEY"),
        "deepseek": ("https://api.deepseek.com", "DEEPSEEK_API_KEY"),
        "mistral": ("https://api.mistral.ai/v1", "MISTRAL_API_KEY"),
        "xai": ("https://api.x.ai/v1", "XAI_API_KEY"),
        "fireworks": ("https://api.fireworks.ai/inference/v1", "FIREWORKS_API_KEY"),
        "ollama": ("http://localhost:11434/v1", "OLLAMA_API_KEY"),
        "lmstudio": ("http://localhost:1234/v1", None),
        "vllm": ("http://localhost:8000/v1", "VLLM_API_KEY"),
    }


def test_a_local_preset_uses_its_key_when_one_is_set():
    model, _ = build("ollama:qwen2.5:3b", env={"OLLAMA_API_KEY": "ollama-cloud"})
    assert secret(model.openai_api_key) == "ollama-cloud"


def test_openai_compatible_needs_a_base_url_and_never_borrows_the_openai_key():
    with pytest.raises(ProviderError, match="needs --base-url"):
        build("openai-compatible:my-model")
    model, target = build("openai-compatible:my-model", base_url="http://gpu-box.lan:9000/v1")
    assert model.openai_api_base == "http://gpu-box.lan:9000/v1"
    # OPENAI_API_KEY is set in KEYS; it must not be sent to someone else's server.
    assert secret(model.openai_api_key) == NO_KEY_PLACEHOLDER
    assert (target.provider, target.endpoint) == ("openai-compatible", "gpu-box.lan:9000")


def test_base_url_and_api_key_env_override_the_defaults():
    env = KEYS | {"MY_PROXY_KEY": "proxy-key"}
    model, target = build("openai:gpt-4.1", env=env, base_url="https://llm-proxy.corp.example/v1", api_key_env="MY_PROXY_KEY")
    assert model.openai_api_base == "https://llm-proxy.corp.example/v1"
    assert secret(model.openai_api_key) == "proxy-key"
    assert target.endpoint == "llm-proxy.corp.example"
    model, _ = build("anthropic:claude-sonnet-4-5", env=env, api_key_env="MY_PROXY_KEY")
    assert secret(model.anthropic_api_key) == "proxy-key"


def test_implicit_endpoint_env_vars_are_ignored(monkeypatch):
    """The recorded endpoint is where requests go: OPENAI_BASE_URL etc. cannot redirect them."""
    monkeypatch.setenv("OPENAI_BASE_URL", "https://elsewhere.example/v1")
    monkeypatch.setenv("OPENAI_API_BASE", "https://elsewhere.example/v1")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://elsewhere.example")
    model, target = build("openai:gpt-4.1")
    assert str(model.root_client.base_url).startswith("https://api.openai.com/v1") and target.endpoint == "api.openai.com"
    model, _ = build("anthropic:claude-sonnet-4-5")
    assert str(model._client.base_url).startswith("https://api.anthropic.com")


def test_no_sampling_params_unless_passed():
    model, target = build("openai:gpt-4.1")
    assert model.temperature is None and model.max_tokens is None and target.params == {}
    model, target = build("openai:gpt-4.1", params={"temperature": 0, "max_tokens": 256})
    assert model.temperature == 0 and model.max_tokens == 256
    assert target.params == {"temperature": 0, "max_tokens": 256}


def test_a_bad_param_fails_before_any_cell_runs():
    with pytest.raises(ValueError):
        build("gemini:gemini-2.5-flash", params={"temperature": 5})


# ---------------------------------------------------------------- refusals


@pytest.mark.parametrize(
    "ref, var",
    [
        ("anthropic:claude-sonnet-4-5", "ANTHROPIC_API_KEY"),
        ("openai:gpt-4.1", "OPENAI_API_KEY"),
        ("azure:dep", "AZURE_OPENAI_API_KEY"),
        ("gemini:gemini-2.5-flash", "GEMINI_API_KEY"),
        ("bedrock:amazon.nova-lite-v1:0", "AWS_REGION"),
        ("openrouter:openai/gpt-4.1", "OPENROUTER_API_KEY"),
        ("groq:llama-3.3-70b-versatile", "GROQ_API_KEY"),
        ("together:meta-llama/Llama-3.3-70B-Instruct-Turbo", "TOGETHER_API_KEY"),
        ("deepseek:deepseek-chat", "DEEPSEEK_API_KEY"),
        ("mistral:mistral-large-latest", "MISTRAL_API_KEY"),
        ("xai:grok-4", "XAI_API_KEY"),
        ("fireworks:accounts/fireworks/models/llama-v3p1-8b-instruct", "FIREWORKS_API_KEY"),
    ],
)
def test_a_missing_credential_names_the_providers_env_var(ref, var):
    with pytest.raises(ProviderError) as err:
        build(ref, env={})
    assert f"{var} is not set" in str(err.value)
    assert "no offline fallback" in str(err.value)


def test_azure_names_each_missing_setting():
    env = {"AZURE_OPENAI_API_KEY": "k"}
    with pytest.raises(ProviderError, match="AZURE_OPENAI_ENDPOINT is not set"):
        build("azure:dep", env=env)
    with pytest.raises(ProviderError, match="OPENAI_API_VERSION is not set"):
        build("azure:dep", env=env | {"AZURE_OPENAI_ENDPOINT": "https://r.openai.azure.com"})


def test_bedrock_without_any_credentials_says_what_it_looked_for(clean_env):
    import os

    with pytest.raises(ProviderError, match="AWS_BEARER_TOKEN_BEDROCK is not set and no AWS credentials"):
        build_model_factory("bedrock:amazon.nova-lite-v1:0", env={**os.environ, "AWS_REGION": "us-east-1"})


def test_local_presets_need_no_key():
    for provider in ("ollama", "lmstudio", "vllm"):
        model, _ = build(f"{provider}:m", env={})
        assert secret(model.openai_api_key) == NO_KEY_PLACEHOLDER


def test_a_named_key_env_that_is_unset_is_refused_even_for_a_local_server():
    with pytest.raises(ProviderError, match="MY_KEY is not set"):
        build("ollama:m", env={}, api_key_env="MY_KEY")
    with pytest.raises(ProviderError, match="MY_KEY is not set"):
        build("openai-compatible:m", env={}, base_url="http://x/v1", api_key_env="MY_KEY")


@pytest.mark.parametrize(
    "ref, module, extra",
    [
        ("anthropic:claude-sonnet-4-5", "langchain_anthropic", "anthropic"),
        ("openai:gpt-4.1", "langchain_openai", "openai"),
        ("azure:dep", "langchain_openai", "openai"),
        ("ollama:qwen2.5:3b", "langchain_openai", "openai"),
        ("gemini:gemini-2.5-flash", "langchain_google_genai", "gemini"),
        ("bedrock:amazon.nova-lite-v1:0", "langchain_aws", "bedrock"),
    ],
)
def test_a_missing_extra_names_the_install_command(monkeypatch, ref, module, extra):
    monkeypatch.setitem(sys.modules, module, None)  # import now raises ImportError
    with pytest.raises(ProviderError) as err:
        build(ref)
    assert f"pip install 'invariant-langgraph[{extra}]'" in str(err.value)
    assert f"pip install -e 'adapters/langgraph[{extra}]'" in str(err.value)
