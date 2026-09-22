"""Shared fixtures. Every model in these tests is the SYNTHETIC ScriptedChatModel."""
from __future__ import annotations

from pathlib import Path

import pytest

from invariant_langgraph.spec import Task, find_repo_root, load_task, select_cells
from invariant_langgraph.trace_file import load_schema

REPO_ROOT = find_repo_root(Path(__file__).resolve().parent)
TASK_NAME = "refund-duplicate-check"


@pytest.fixture(scope="session")
def repo_root() -> Path:
    return REPO_ROOT


@pytest.fixture(scope="session")
def task() -> Task:
    return load_task(REPO_ROOT, TASK_NAME)


@pytest.fixture(scope="session")
def schema() -> dict:
    return load_schema(REPO_ROOT)


@pytest.fixture()
def selection(task: Task):
    return select_cells(task, "smoke")


@pytest.fixture()
def fake():
    """SYNTHETIC: a local server speaking the providers' wire protocols (tests/fake_providers.py)."""
    from tests.fake_providers import FakeProviders

    server = FakeProviders()
    yield server
    server.close()


@pytest.fixture()
def clean_env(monkeypatch):
    """No provider credentials or endpoint overrides from the machine running the tests."""
    import os

    for var in list(os.environ):
        if var.startswith(("ANTHROPIC_", "OPENAI_", "AZURE_OPENAI_", "GEMINI_", "GOOGLE_", "AWS_")) or var.endswith("_API_KEY"):
            monkeypatch.delenv(var, raising=False)
    # boto3 must not find the developer's ~/.aws credentials.
    monkeypatch.setenv("AWS_SHARED_CREDENTIALS_FILE", "/nonexistent/credentials")
    monkeypatch.setenv("AWS_CONFIG_FILE", "/nonexistent/config")
    monkeypatch.setenv("AWS_EC2_METADATA_DISABLED", "true")
    return monkeypatch
