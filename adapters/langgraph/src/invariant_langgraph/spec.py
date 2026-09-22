"""Read a task spec and its variant fixture from an invariant repo's tasks/ directory.

The TypeScript CLI (`invariant validate`) is the authoritative validator of these files.
This module only checks the parts the adapter reads, and refuses rather than guesses when
one is missing.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml


class SpecError(Exception):
    """A task spec or fixture the adapter cannot use."""


def find_repo_root(start: Path | None = None) -> Path:
    """The nearest ancestor holding tasks/ and schemas/ (an invariant repo)."""
    here = (start or Path.cwd()).resolve()
    for candidate in [here, *here.parents]:
        if (candidate / "tasks").is_dir() and (candidate / "schemas").is_dir():
            return candidate
    raise SpecError(
        f"no invariant repo (a directory with tasks/ and schemas/) at or above {here}; pass --repo-root"
    )


@dataclass(frozen=True)
class Variant:
    id: str
    text: str


@dataclass(frozen=True)
class Task:
    name: str
    spec: dict[str, Any]
    fixture_version: int
    variants: list[Variant]

    @property
    def dangerous(self) -> dict[str, str]:
        """Dangerous tool name -> sandbox_response, from tools.dangerous."""
        return {d["name"]: d["sandbox_response"] for d in self.spec["tools"].get("dangerous", [])}

    @property
    def allowed(self) -> list[str]:
        return list(self.spec["tools"]["allowed"])

    @property
    def max_wall_clock_seconds(self) -> float:
        return float(self.spec["execution"]["max_wall_clock_seconds"])


def load_task(repo_root: Path, name: str) -> Task:
    spec_path = repo_root / "tasks" / f"{name}.yaml"
    fixture_path = repo_root / "tasks" / f"{name}.variants.json"
    if not spec_path.is_file():
        raise SpecError(f"no task spec at tasks/{name}.yaml")
    if not fixture_path.is_file():
        raise SpecError(f"no variant fixture at tasks/{name}.variants.json")
    spec = yaml.safe_load(spec_path.read_text(encoding="utf-8"))
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    problems: list[str] = []
    if not isinstance(spec, dict):
        raise SpecError(f"tasks/{name}.yaml is not a mapping")
    if spec.get("name") != name:
        problems.append(f"spec name {spec.get('name')!r} does not match tasks/{name}.yaml")
    tools = spec.get("tools") or {}
    if not isinstance(tools.get("allowed"), list) or not tools["allowed"]:
        problems.append("spec tools.allowed is missing or empty")
    for d in tools.get("dangerous") or []:
        if not isinstance(d, dict) or not isinstance(d.get("name"), str) or not isinstance(d.get("sandbox_response"), str):
            problems.append("every tools.dangerous entry needs a name and a string sandbox_response")
    execution = spec.get("execution") or {}
    for key in ("max_wall_clock_seconds", "trials_smoke", "trials_full", "variants_smoke", "variants_full"):
        if not isinstance(execution.get(key), (int, float)):
            problems.append(f"spec execution.{key} is missing")
    if fixture.get("task") != name:
        problems.append(f"fixture task {fixture.get('task')!r} does not match tasks/{name}.variants.json")
    if not isinstance(fixture.get("fixture_version"), int):
        problems.append("fixture_version is missing")
    variants = fixture.get("variants")
    if not isinstance(variants, list) or not variants:
        problems.append("fixture has no variants")
    if problems:
        raise SpecError(f"task {name!r} is not usable (run `invariant validate`):\n" + "\n".join(f"  - {p}" for p in problems))
    return Task(
        name=name,
        spec=spec,
        fixture_version=fixture["fixture_version"],
        variants=[Variant(id=v["id"], text=v["text"]) for v in variants],
    )


@dataclass(frozen=True)
class Selection:
    tier: str
    variants: list[Variant]
    trials: int
    variants_requested: int
    #: True when --variants/--trials overrode the tier's shape.
    overridden: bool


def select_cells(task: Task, tier: str, variant_ids: list[str] | None = None, trials: int | None = None) -> Selection:
    """The tier's cells: its first N fixture variants x its trial count, as `invariant run` selects them.

    `variant_ids` / `trials` override the shape (for a focused reproduction); the trace
    files then carry the real shape and `invariant ingest` warns that it is not the tier's.
    """
    if tier not in ("smoke", "full"):
        raise SpecError(f"tier must be smoke or full, got {tier!r}")
    execution = task.spec["execution"]
    requested = int(execution[f"variants_{tier}"])
    variants = task.variants[:requested]
    n_trials = int(execution[f"trials_{tier}"])
    overridden = False
    if variant_ids is not None:
        by_id = {v.id: v for v in task.variants}
        unknown = [v for v in variant_ids if v not in by_id]
        if unknown:
            raise SpecError(f"no variant(s) {', '.join(unknown)} in tasks/{task.name}.variants.json")
        variants = [by_id[v] for v in variant_ids]
        requested = len(variants)
        overridden = True
    if trials is not None:
        if trials < 1:
            raise SpecError("--trials must be a positive integer")
        n_trials = trials
        overridden = True
    return Selection(tier=tier, variants=variants, trials=n_trials, variants_requested=requested, overridden=overridden)
