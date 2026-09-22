"""Trace files: what the driver writes validates against the checked-in JSON Schema, and bad files do not."""
from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from invariant_langgraph.cli import main
from invariant_langgraph.trace_file import FORMAT, TraceFileError, validation_errors, write_trace

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "princeton-synthetic"
RUN_ARGS = [
    "run",
    "--task", "refund-duplicate-check",
    "--tier", "smoke",
    "--variants", "v1",
    "--trials", "5",
    "--graph", "invariant_langgraph.examples.refund:build_graph",
    "--tools", "invariant_langgraph.examples.refund:make_tools",
    "--model-factory", "invariant_langgraph.examples.refund_scripted:princeton_model",
]


@pytest.fixture(scope="module")
def princeton_dir(tmp_path_factory, repo_root) -> Path:
    out = tmp_path_factory.mktemp("princeton")
    assert main([*RUN_ARGS, "--repo-root", str(repo_root), "--out", str(out)]) == 0
    return out


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def test_the_schema_is_the_version_this_adapter_writes(schema):
    assert schema["title"] == FORMAT
    assert schema["properties"]["format"]["const"] == FORMAT


def test_driver_writes_one_valid_file_per_cell(princeton_dir, schema):
    files = sorted(princeton_dir.glob("*.json"))
    assert [f.name for f in files] == [f"refund-duplicate-check.v1.trial-00{n}.json" for n in range(1, 6)]
    traces = [_load(f) for f in files]
    for trace in traces:
        assert validation_errors(trace, schema) == []
    assert len({t["batch"]["key"] for t in traces}) == 1
    assert {t["status"] for t in traces} == {"ok"}


def test_the_synthetic_princeton_batch_refunds_three_of_five_all_sandboxed(princeton_dir):
    traces = {_load(f)["trial"]: _load(f) for f in princeton_dir.glob("*.json")}
    refunds = {t: [c for c in tr["tool_calls"] if c["tool_name"] == "process_refund"] for t, tr in traces.items()}
    assert sorted(t for t, calls in refunds.items() if calls) == [1, 3, 5]
    assert all(c["is_sandboxed"] for calls in refunds.values() for c in calls)
    # Fresh request_id per refund: only volatile-field masking can group them.
    assert len({calls[0]["args"]["request_id"] for calls in refunds.values() if calls}) == 3
    assert all(tr["fingerprint"]["model_version"] == "scripted-stand-in (NOT a model)" for tr in traces.values())


def test_committed_fixtures_still_validate(schema):
    """tests/fixtures/princeton-synthetic is what the TypeScript ingest test imports."""
    files = sorted(FIXTURES.glob("*.json"))
    assert len(files) == 5
    for f in files:
        assert validation_errors(_load(f), schema) == [], f.name


@pytest.mark.parametrize(
    "mutate, expected",
    [
        (lambda t: t.pop("status"), "'status' is a required property"),
        (lambda t: t.update(status="flaky"), "status"),
        (lambda t: t.update(surprise=1), "Additional properties"),
        (lambda t: t["tool_calls"][0].update(timestamp="yesterday"), "tool_calls.0.timestamp"),
        (lambda t: t["tool_calls"][0].pop("is_sandboxed"), "is_sandboxed"),
        (lambda t: t.update(format="invariant.trial-trace/v0"), "format"),
        (lambda t: t.update(trial=0), "trial"),
    ],
)
def test_schema_rejects_malformed_traces(princeton_dir, schema, mutate, expected):
    trace = copy.deepcopy(_load(next(princeton_dir.glob("*.json"))))
    mutate(trace)
    errors = validation_errors(trace, schema)
    assert errors and any(expected in e for e in errors), errors


def test_write_trace_refuses_an_invalid_trace(princeton_dir, schema, tmp_path):
    trace = _load(next(princeton_dir.glob("*.json")))
    trace["tool_calls"][0]["sequence_index"] = -1
    with pytest.raises(TraceFileError):
        write_trace(tmp_path / "bad.json", trace, schema)
    assert not (tmp_path / "bad.json").exists()
