"""Real-mode chat models: `provider:model` references mapped to LangChain chat models.

    anthropic:claude-sonnet-4-5          openai:gpt-4.1          gemini:gemini-2.5-flash
    bedrock:anthropic.claude-3-5-haiku-20241022-v1:0            azure:<deployment name>
    ollama:qwen2.5:3b    groq:llama-3.3-70b-versatile    openai-compatible:<model> --base-url URL

The reference is split on the FIRST colon only, so the model part may contain colons
(Ollama tags, Bedrock ids). Provider names are the TypeScript CLI's.

Every model is built with the provider client's retries turned off: a provider failure
must surface as that cell's infra_error, never be retried invisibly inside one recorded
run. Every model is also built with its endpoint and key passed explicitly, never picked
up implicitly from provider env vars such as OPENAI_BASE_URL, so the endpoint recorded in
the trace is the one the requests went to, and a key meant for one provider is never sent
to another's endpoint.

Nothing about sampling is set here: no temperature, no max_tokens. The agent under test
runs with its provider's defaults unless the user passes --param key=value, and those
params are passed to the model's constructor as given. Two integrations add a value of
their own: langchain-anthropic always sends max_tokens (the Messages API requires it; it
uses the model's profile, else 4096), and langchain-google-genai would send
temperature=0.7, which is suppressed here. The driver logs the sampling params the model
object reports for its first call, so what was sent is on record either way.
"""
from __future__ import annotations

import importlib
import os
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping
from urllib.parse import urlsplit

from .driver import CellInfo

# The provider package each extra installs, and the LangChain class built from it.
EXTRAS = {
    "anthropic": ("langchain_anthropic", "langchain-anthropic"),
    "openai": ("langchain_openai", "langchain-openai"),
    "gemini": ("langchain_google_genai", "langchain-google-genai"),
    "bedrock": ("langchain_aws", "langchain-aws"),
}

NO_FALLBACK = (
    "Running a trial drives the agent under test through the real provider, there is no "
    "offline fallback because a faked agent response would produce a trace that measures "
    "nothing. Set it and re-run (or pass --model-factory to drive the graph with a model "
    "of your own)."
)


@dataclass(frozen=True)
class Preset:
    """An OpenAI-compatible endpoint (checked against each provider's docs, 2026-09)."""

    base_url: str
    key_env: str | None
    key_required: bool = True


PRESETS: dict[str, Preset] = {
    "openrouter": Preset("https://openrouter.ai/api/v1", "OPENROUTER_API_KEY"),
    "groq": Preset("https://api.groq.com/openai/v1", "GROQ_API_KEY"),
    "together": Preset("https://api.together.ai/v1", "TOGETHER_API_KEY"),
    "deepseek": Preset("https://api.deepseek.com", "DEEPSEEK_API_KEY"),
    "mistral": Preset("https://api.mistral.ai/v1", "MISTRAL_API_KEY"),
    "xai": Preset("https://api.x.ai/v1", "XAI_API_KEY"),
    "fireworks": Preset("https://api.fireworks.ai/inference/v1", "FIREWORKS_API_KEY"),
    # Local servers: no key unless one is configured (Ollama's cloud and a vLLM started
    # with --api-key take one).
    "ollama": Preset("http://localhost:11434/v1", "OLLAMA_API_KEY", key_required=False),
    "lmstudio": Preset("http://localhost:1234/v1", None, key_required=False),
    "vllm": Preset("http://localhost:8000/v1", "VLLM_API_KEY", key_required=False),
}

NATIVE = ("anthropic", "openai", "azure", "gemini", "bedrock", "openai-compatible")
PROVIDERS = NATIVE + tuple(PRESETS)

# Sent to keyless OpenAI-compatible servers: the openai client refuses to start without a
# key, and without an explicit one it would fall back to OPENAI_API_KEY, sending a real
# OpenAI key to a third-party endpoint.
NO_KEY_PLACEHOLDER = "no-key"

DEFAULT_BASE_URLS = {
    "anthropic": "https://api.anthropic.com",
    "openai": "https://api.openai.com/v1",
    "gemini": "https://generativelanguage.googleapis.com",
}

# Constructor arguments this module owns; --param may not override them.
RESERVED_PARAMS = frozenset(
    {"model", "model_name", "model_id", "api_key", "base_url", "max_retries", "retries", "azure_endpoint",
     "azure_deployment", "api_version", "openai_api_version", "region_name", "endpoint_url", "config",
     "google_api_key", "vertexai", "client", "async_client"}
)


class ProviderError(RuntimeError):
    """A --model reference, credential or install problem, reported before any trial runs."""


@dataclass(frozen=True)
class ModelRef:
    provider: str
    model: str


@dataclass
class ModelTarget:
    """What real mode is driving, as recorded in every trace's fingerprint."""

    provider: str
    model: str
    endpoint: str | None
    #: The provider package's distribution name, recorded in adapter.framework.
    package: str
    params: dict[str, Any] = field(default_factory=dict)


def parse_model_ref(ref: str) -> ModelRef:
    provider, sep, model = ref.partition(":")
    provider = provider.strip()
    model = model.strip()
    if not sep or not provider or not model:
        raise ProviderError(
            f"--model expects provider:model (e.g. anthropic:claude-sonnet-4-5, openai:gpt-4.1, "
            f"ollama:qwen2.5:3b), got {ref!r}. Providers: {', '.join(PROVIDERS)}"
        )
    if provider not in PROVIDERS:
        raise ProviderError(f"unknown provider {provider!r} in --model {ref!r}. Providers: {', '.join(PROVIDERS)}")
    return ModelRef(provider=provider, model=model)


def parse_params(pairs: list[str] | None) -> dict[str, Any]:
    """--param key=value, repeated. The value is JSON when it parses as JSON (0.2, true, 512), else a string."""
    import json

    out: dict[str, Any] = {}
    for pair in pairs or []:
        key, sep, raw = pair.partition("=")
        key = key.strip()
        if not sep or not key:
            raise ProviderError(f"--param expects key=value, got {pair!r}")
        if key in RESERVED_PARAMS:
            raise ProviderError(f"--param {key} is set by the adapter itself (use --model / --base-url / --api-key-env)")
        try:
            out[key] = json.loads(raw)
        except ValueError:
            out[key] = raw
    return out


def endpoint_host(url: str | None) -> str | None:
    """Host[:port] only, never the scheme, path, query, or any credentials in the URL."""
    if not url:
        return None
    parts = urlsplit(url if "://" in url else f"//{url}")
    host = parts.hostname
    if not host:
        return None
    if ":" in host:  # IPv6 literal
        host = f"[{host}]"
    return f"{host}:{parts.port}" if parts.port else host


def import_provider(module: str, extra: str, provider: str) -> Any:
    try:
        return importlib.import_module(module)
    except ImportError as err:
        raise ProviderError(
            f"--model {provider}:... needs the '{extra}' extra, which is not installed ({err}). Install it with:\n"
            f"  pip install 'invariant-langgraph[{extra}]'\n"
            f"or, from a checkout of the repo:  pip install -e 'adapters/langgraph[{extra}]'"
        ) from err


def _missing(var: str, provider: str, what: str = "API key") -> ProviderError:
    return ProviderError(f"{var} is not set. --model {provider}:... needs the provider's {what} in {var}. {NO_FALLBACK}")


def _key(env: Mapping[str, str], var: str, provider: str) -> str:
    value = env.get(var)
    if not value:
        raise _missing(var, provider)
    return value


def build_model_factory(
    ref: str,
    *,
    base_url: str | None = None,
    api_key_env: str | None = None,
    params: dict[str, Any] | None = None,
    env: Mapping[str, str] | None = None,
) -> tuple[Callable[[CellInfo], Any], ModelTarget]:
    """Check the reference, the install and the credentials up front, then return a
    factory building a fresh chat model per cell, and the target it drives."""
    env = os.environ if env is None else env
    params = dict(params or {})
    mref = parse_model_ref(ref)
    provider, model = mref.provider, mref.model

    if provider == "anthropic":
        mod = import_provider("langchain_anthropic", "anthropic", provider)
        key = _key(env, api_key_env or "ANTHROPIC_API_KEY", provider)
        url = base_url or DEFAULT_BASE_URLS["anthropic"]
        make = lambda: mod.ChatAnthropic(model=model, api_key=key, base_url=url, max_retries=0, **params)  # noqa: E731
        return _factory(make), ModelTarget(provider, model, endpoint_host(url), "langchain-anthropic", params)

    if provider == "gemini":
        mod = import_provider("langchain_google_genai", "gemini", provider)
        if api_key_env:
            key = _key(env, api_key_env, provider)
        else:
            key = env.get("GOOGLE_API_KEY") or env.get("GEMINI_API_KEY")  # Google: GOOGLE_API_KEY wins when both are set
            if not key:
                raise _missing("GEMINI_API_KEY", provider, "API key (GOOGLE_API_KEY is also accepted)")
        url = base_url or DEFAULT_BASE_URLS["gemini"]
        # max_retries=1, not 0: langchain-google-genai passes it to the Google SDK as the
        # total attempt count, and the SDK reads 0 as "use the default" (5 retries).
        # temperature=None unless given: langchain-google-genai otherwise sends 0.7, a
        # sampling choice the user did not make. None leaves it to the API's default.
        sampling = {"temperature": None, **params}
        make = lambda: mod.ChatGoogleGenerativeAI(  # noqa: E731
            model=model, google_api_key=key, base_url=url, vertexai=False, max_retries=1, **sampling
        )
        return _factory(make), ModelTarget(provider, model, endpoint_host(url), "langchain-google-genai", params)

    if provider == "bedrock":
        mod = import_provider("langchain_aws", "bedrock", provider)
        from botocore.config import Config

        region = env.get("AWS_REGION") or env.get("AWS_DEFAULT_REGION")
        if not region:
            raise _missing("AWS_REGION", provider, "region (AWS_DEFAULT_REGION is also accepted)")
        token_var = api_key_env or "AWS_BEARER_TOKEN_BEDROCK"
        token = env.get(token_var)
        if api_key_env and not token:
            raise _missing(api_key_env, provider, "Bedrock API key")
        if not token and not _aws_credentials(env):
            raise ProviderError(
                "AWS_BEARER_TOKEN_BEDROCK is not set and no AWS credentials were found (AWS_ACCESS_KEY_ID/"
                "AWS_SECRET_ACCESS_KEY, AWS_PROFILE, or the rest of the standard AWS credential chain). "
                f"--model bedrock:... needs one or the other. {NO_FALLBACK}"
            )
        url = base_url or f"https://bedrock-runtime.{region}.amazonaws.com"
        # total_max_attempts=1: one request, no botocore retries.
        retries = {"total_max_attempts": 1, "mode": "standard"}
        extra: dict[str, Any] = {"api_key": token} if token else {}
        make = lambda: mod.ChatBedrockConverse(  # noqa: E731
            model=model, region_name=region, endpoint_url=url, config=Config(retries=retries), **extra, **params
        )
        return _factory(make), ModelTarget(provider, model, endpoint_host(url), "langchain-aws", params)

    # Everything else speaks the OpenAI chat completions protocol through langchain-openai.
    mod = import_provider("langchain_openai", "openai", provider)

    if provider == "azure":
        key = _key(env, api_key_env or "AZURE_OPENAI_API_KEY", provider)
        url = base_url or env.get("AZURE_OPENAI_ENDPOINT")
        if not url:
            raise _missing("AZURE_OPENAI_ENDPOINT", provider, "resource endpoint (or pass --base-url)")
        version = env.get("OPENAI_API_VERSION")
        if not version:
            raise _missing("OPENAI_API_VERSION", provider, "API version (e.g. 2024-10-21)")
        # The model part of azure:<name> is the deployment name.
        make = lambda: mod.AzureChatOpenAI(  # noqa: E731
            azure_deployment=model, azure_endpoint=url, api_version=version, api_key=key, max_retries=0, **params
        )
        return _factory(make), ModelTarget(provider, model, endpoint_host(url), "langchain-openai", params)

    if provider == "openai":
        key = _key(env, api_key_env or "OPENAI_API_KEY", provider)
        url = base_url or DEFAULT_BASE_URLS["openai"]
    elif provider == "openai-compatible":
        if not base_url:
            raise ProviderError("--model openai-compatible:... needs --base-url (the server's OpenAI-compatible root, e.g. http://host:port/v1)")
        url = base_url
        key = _key(env, api_key_env, provider) if api_key_env else NO_KEY_PLACEHOLDER
    else:
        preset = PRESETS[provider]
        url = base_url or preset.base_url
        var = api_key_env or preset.key_env
        if var and (preset.key_required or api_key_env):
            key = _key(env, var, provider)
        else:
            key = (env.get(var) if var else None) or NO_KEY_PLACEHOLDER
    make = lambda: mod.ChatOpenAI(model=model, api_key=key, base_url=url, max_retries=0, **params)  # noqa: E731
    return _factory(make), ModelTarget(provider, model, endpoint_host(url), "langchain-openai", params)


def _factory(make: Callable[[], Any]) -> Callable[[CellInfo], Any]:
    # Build one model now so a bad parameter fails before the first cell, not inside it.
    make()
    return lambda _cell: make()


def _aws_credentials(env: Mapping[str, str]) -> bool:
    if env.get("AWS_ACCESS_KEY_ID") and env.get("AWS_SECRET_ACCESS_KEY"):
        return True
    if env is not os.environ:
        return bool(env.get("AWS_PROFILE"))
    import boto3

    return boto3.Session().get_credentials() is not None
