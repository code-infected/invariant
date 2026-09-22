"""SYNTHETIC. A scripted chat model for exercising the adapter without a model.

This is not a model and nothing it produces is a finding about one. It replays a fixed
list of turns (tool calls, or a final text), one per model call, so the graph, the tool
sandbox, the recorder and the trace files can be tested end to end with no API key. It
reports its model id as "scripted-stand-in (NOT a model)", which carries the marker the
trace store and dashboard use to label runs SYNTHETIC (SCRIPTED_STAND_IN_MARKER in
@invariant/trace-store).
"""
from __future__ import annotations

from typing import Any, Sequence

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.utils.function_calling import convert_to_openai_tool

SCRIPTED_MODEL_NAME = "scripted-stand-in"
SCRIPTED_MODEL_VERSION = "scripted-stand-in (NOT a model)"


class ScriptError(Exception):
    """The script ran out, or named a tool the graph did not bind."""


class ScriptedChatModel(BaseChatModel):
    """Replays `steps`: turn n answers with steps[n], n = AI messages already in the conversation.

    A step is {"tool": name, "args": {...}} (one tool call) or {"text": "..."} (a final
    answer with no tool call).
    """

    steps: list[dict[str, Any]]
    model_name: str = SCRIPTED_MODEL_NAME
    reported_model: str = SCRIPTED_MODEL_VERSION
    bound_tools: list[str] | None = None

    @property
    def _llm_type(self) -> str:
        return SCRIPTED_MODEL_NAME

    @property
    def _identifying_params(self) -> dict[str, Any]:
        return {"model_name": self.model_name}

    def bind_tools(self, tools: Sequence[Any], **kwargs: Any) -> "ScriptedChatModel":
        names = [convert_to_openai_tool(t)["function"]["name"] for t in tools]
        return self.model_copy(update={"bound_tools": names})

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: Any = None,
        **kwargs: Any,
    ) -> ChatResult:
        n = sum(1 for m in messages if isinstance(m, AIMessage))
        if n >= len(self.steps):
            raise ScriptError(f"scripted model: no step {n} (script has {len(self.steps)})")
        step = self.steps[n]
        meta = {"model_name": self.reported_model}
        usage = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
        if "tool" in step:
            if self.bound_tools is not None and step["tool"] not in self.bound_tools:
                raise ScriptError(f"scripted model: step {n} calls {step['tool']!r}, which the graph did not bind")
            message = AIMessage(
                content="",
                tool_calls=[{"name": step["tool"], "args": step.get("args", {}), "id": f"call_{n}", "type": "tool_call"}],
                response_metadata=meta,
                usage_metadata=usage,
            )
        else:
            message = AIMessage(content=step["text"], response_metadata=meta, usage_metadata=usage)
        return ChatResult(generations=[ChatGeneration(message=message)])
