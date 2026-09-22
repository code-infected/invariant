"""The trial trace file: build, validate against the checked-in JSON Schema, write.

The format is defined once, in packages/cli/src/schema/trial-trace.ts, and published as
schemas/trial-trace.v1.schema.json. This module validates every file against that
published schema before writing it, and `invariant ingest` validates it again (with the
Zod schema it was generated from) before reading it. Neither side trusts the other.
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any

from jsonschema import Draft7Validator, FormatChecker

FORMAT = "invariant.trial-trace/v1"
SCHEMA_PATH = Path("schemas") / "trial-trace.v1.schema.json"


class TraceFileError(Exception):
    """A trace that does not match the schema; never written."""


def load_schema(repo_root: Path) -> dict[str, Any]:
    path = repo_root / SCHEMA_PATH
    if not path.is_file():
        raise TraceFileError(f"no trace file schema at {path}")
    schema = json.loads(path.read_text(encoding="utf-8"))
    if schema.get("title") != FORMAT:
        raise TraceFileError(f"{path} is {schema.get('title')!r}, this adapter writes {FORMAT}")
    return schema


_formats = FormatChecker(formats=())


@_formats.checks("date-time", raises=ValueError)
def _is_datetime(value: object) -> bool:
    if not isinstance(value, str):
        return True
    # RFC 3339 needs a date, a time and an offset; fromisoformat on 3.10 does not take "Z".
    if "T" not in value or not (value.endswith("Z") or value[-6] in "+-"):
        raise ValueError(f"{value!r} is not an RFC 3339 timestamp with an offset")
    datetime.fromisoformat(value[:-1] + "+00:00" if value.endswith("Z") else value)
    return True


def validation_errors(trace: Any, schema: dict[str, Any]) -> list[str]:
    validator = Draft7Validator(schema, format_checker=_formats)
    errors = sorted(validator.iter_errors(trace), key=lambda e: list(e.absolute_path))
    return [f"{'.'.join(str(p) for p in e.absolute_path) or '(root)'}: {e.message}" for e in errors]


def write_trace(path: Path, trace: dict[str, Any], schema: dict[str, Any]) -> Path:
    errors = validation_errors(trace, schema)
    if errors:
        raise TraceFileError(f"refusing to write {path}, it does not match {FORMAT}:\n" + "\n".join(f"  - {e}" for e in errors))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(trace, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


def trace_filename(task: str, variant: str, trial: int) -> str:
    return f"{task}.{variant}.trial-{trial:03d}.json"
