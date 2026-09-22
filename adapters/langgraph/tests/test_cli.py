"""The driver's refusals and error reporting."""
from __future__ import annotations

from invariant_langgraph.cli import main
from invariant_langgraph.driver import MISSING_KEY_MESSAGE, classify_error

BASE = ["run", "--task", "refund-duplicate-check", "--tier", "smoke", "--graph", "invariant_langgraph.examples.refund:build_graph"]


def test_real_mode_without_a_key_refuses_before_running(monkeypatch, tmp_path, repo_root, capsys):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    code = main([*BASE, "--tools", "invariant_langgraph.examples.refund:make_tools", "--out", str(tmp_path / "o"), "--repo-root", str(repo_root)])
    assert code == 1
    assert MISSING_KEY_MESSAGE in capsys.readouterr().err
    assert not (tmp_path / "o").exists()


def test_tools_that_do_not_cover_the_task_are_refused(tmp_path, repo_root, capsys):
    code = main([
        *BASE,
        "--tools", "tests.test_cli:only_lookup",
        "--model-factory", "invariant_langgraph.examples.refund_scripted:princeton_model",
        "--out", str(tmp_path / "o"),
        "--repo-root", str(repo_root),
    ])
    assert code == 1
    err = capsys.readouterr().err
    assert "check_refund_history" in err and "process_refund" in err and "reply_to_user" in err
    assert not list((tmp_path / "o").glob("*.json")) if (tmp_path / "o").exists() else True


def test_an_out_dir_holding_trace_files_is_refused(tmp_path, repo_root, capsys):
    (tmp_path / "old.json").write_text("{}")
    code = main([
        *BASE,
        "--tools", "invariant_langgraph.examples.refund:make_tools",
        "--model-factory", "invariant_langgraph.examples.refund_scripted:princeton_model",
        "--out", str(tmp_path),
        "--repo-root", str(repo_root),
    ])
    assert code == 1
    assert "already holds .json files" in capsys.readouterr().err


def test_smoke_tier_shape_comes_from_the_task_spec(tmp_path, repo_root):
    import json

    out = tmp_path / "o"
    code = main([
        *BASE,
        "--tools", "invariant_langgraph.examples.refund:make_tools",
        "--model-factory", "invariant_langgraph.examples.refund_scripted:princeton_model",
        "--out", str(out),
        "--repo-root", str(repo_root),
    ])
    assert code == 0
    traces = [json.loads(p.read_text()) for p in sorted(out.glob("*.json"))]
    # tasks/refund-duplicate-check.yaml: variants_smoke 2, trials_smoke 2.
    assert sorted((t["variant"]["id"], t["trial"]) for t in traces) == [("v1", 1), ("v1", 2), ("v2", 1), ("v2", 2)]
    assert traces[0]["batch"]["variant_labels"] == ["v1", "v2"] and traces[0]["batch"]["trials_per_variant"] == 2


class _Status(Exception):
    def __init__(self, status_code):
        super().__init__(f"HTTP {status_code}")
        self.status_code = status_code


def test_provider_errors_are_classified_like_the_mcp_driver():
    assert classify_error(_Status(429))["kind"] == "provider"
    assert classify_error(_Status(529)) == {"kind": "provider", "message": "_Status: HTTP 529", "http_status": 529}
    assert classify_error(_Status(401))["kind"] == "provider_rejected"
    assert classify_error(ValueError("bug"))["kind"] == "harness"


def only_lookup():
    from invariant_langgraph.examples.refund import make_tools

    return make_tools()[:1]
