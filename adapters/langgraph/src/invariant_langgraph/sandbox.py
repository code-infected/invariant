"""Dangerous-tool sandboxing by wrapping LangChain tool objects.

Same semantics as the MCP proxy's interception (packages/mcp-proxy/src/proxy.ts): a call
to a tool the task spec declares dangerous is answered with the spec's sandbox_response
text, and the real tool function is never called. The agent sees a tool with the same
name, description and argument schema as the original, so what it is offered does not
change; only what happens when it calls the tool does.

The wrapper is marked in its tool metadata (SANDBOX_METADATA_KEY). LangChain hands tool
metadata to callback handlers on every call, which is how the recorder knows a call was
answered by the sandbox rather than assuming it from the tool's name.
"""
from __future__ import annotations

from typing import Any, Iterable, Mapping

from langchain_core.tools import BaseTool, StructuredTool

SANDBOX_METADATA_KEY = "invariant_sandboxed"


def is_sandboxed_tool(tool: BaseTool) -> bool:
    return bool((tool.metadata or {}).get(SANDBOX_METADATA_KEY))


def sandbox_tool(tool: BaseTool, sandbox_response: str) -> BaseTool:
    """A stand-in for `tool` that returns `sandbox_response` and never runs the original."""

    def _sandboxed(**_kwargs: Any) -> str:
        return sandbox_response

    async def _asandboxed(**_kwargs: Any) -> str:
        return sandbox_response

    return StructuredTool(
        name=tool.name,
        description=tool.description,
        # The original schema, unchanged: the wrapper validates arguments exactly as the
        # real tool would, and the model is offered the identical tool definition.
        args_schema=tool.args_schema,
        func=_sandboxed,
        coroutine=_asandboxed,
        return_direct=tool.return_direct,
        tags=list(tool.tags or []),
        metadata={**(tool.metadata or {}), SANDBOX_METADATA_KEY: True},
    )


def sandbox_tools(tools: Iterable[BaseTool], dangerous: Mapping[str, str]) -> list[BaseTool]:
    """Wrap every tool named in `dangerous` (name -> sandbox_response); others pass through as-is."""
    return [sandbox_tool(t, dangerous[t.name]) if t.name in dangerous else t for t in tools]
