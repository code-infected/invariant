"""The driver's refusals and error reporting."""
from __future__ import annotations

from invariant_langgraph.cli import main
from invariant_langgraph.driver import classify_error

BASE = ["run", "--task", "refund-duplicate-check", "--tier", "smoke", "--graph", "invariant_langgraph.examples.refund:build_graph"]


def test_real_mode_without_a_key_refuses_before_running(clean_env, tmp_path, repo_root, capsys):
    # No --model: the default is anthropic:claude-sonnet-4-5, which needs ANTHROPIC_API_KEY.
    code = main([*BASE, "--tools", "invariant_langgraph.examples.refund:make_tools", "--out", str(tmp_path / "o"), "--repo-root", str(repo_root)])
    assert code == 1
    err = capsys.readouterr().err
    assert "ANTHROPIC_API_KEY is not set" in err and "no offline fallback" in err
    assert not (tmp_path / "o").exists()


def test_each_provider_names_its_own_key(clean_env, tmp_path, repo_root, capsys):
    code = main([
        *BASE, "--tools", "invariant_langgraph.examples.refund:make_tools", "--model", "groq:llama-3.3-70b-versatile",
        "--out", str(tmp_path / "o"), "--repo-root", str(repo_root),
    ])
    assert code == 1
    assert "GROQ_API_KEY is not set" in capsys.readouterr().err
    assert not (tmp_path / "o").exists()


def test_provider_flags_do_not_apply_to_a_model_factory(tmp_path, repo_root, capsys):
    code = main([
        *BASE, "--tools", "invariant_langgraph.examples.refund:make_tools",
        "--model-factory", "invariant_langgraph.examples.refund_scripted:princeton_model", "--param", "temperature=0",
        "--out", str(tmp_path / "o"), "--repo-root", str(repo_root),
    ])
    assert code == 1
    assert "apply to --model, not --model-factory" in capsys.readouterr().err


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


def test_the_scripted_path_needs_no_provider_extra(repo_root, tmp_path):
    """A base install (no extras) runs --model-factory: no provider package is imported."""
    import subprocess
    import sys

    code = (
        "import sys\n"
        "for m in ('langchain_anthropic', 'langchain_openai', 'langchain_google_genai', 'langchain_aws', 'anthropic', 'openai', 'boto3'):\n"
        "    sys.modules[m] = None\n"
        "from invariant_langgraph.cli import main\n"
        f"sys.exit(main({[*BASE, '--tools', 'invariant_langgraph.examples.refund:make_tools', '--model-factory', 'invariant_langgraph.examples.refund_scripted:princeton_model', '--out', str(tmp_path / 'o'), '--repo-root', str(repo_root)]!r}))\n"
    )
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert len(list((tmp_path / "o").glob("*.json"))) == 4
