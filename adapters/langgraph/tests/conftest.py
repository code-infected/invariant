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
