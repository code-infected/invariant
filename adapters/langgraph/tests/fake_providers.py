"""SYNTHETIC. A local HTTP server that speaks four providers' wire protocols, for tests.

Nothing here is a model. It answers each request from a fixed script, the same step
format as scripted.ScriptedChatModel ({"tool": name, "args": {...}} or {"text": ...}),
choosing step n where n is the number of assistant turns already in the request. It
exists so the real provider clients (openai, anthropic, google-genai, botocore) and the
real LangChain integrations can be exercised end to end, over real HTTP, with no key.

  POST .../chat/completions          OpenAI chat completions (openai, azure, every preset)
  POST .../messages                  Anthropic Messages
  POST .../models/{m}:generateContent  Gemini
  POST /model/{id}/converse          Bedrock Converse

Set `fail = (status, error_code)` to answer every request with a provider-shaped error.
Every request is kept in `requests` (path, lower-cased headers, JSON body).
"""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import unquote, urlsplit

REPORTED_MODEL = "fake-model-2026-01-01 (SYNTHETIC)"


class FakeProviders:
    def __init__(self) -> None:
        self.steps: list[dict[str, Any]] = [{"text": "hello"}]
        self.reported_model: str | None = REPORTED_MODEL
        self.fail: tuple[int, str] | None = None
        self.requests: list[dict[str, Any]] = []
        self._lock = threading.Lock()
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: Any) -> None:  # quiet
                pass

            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("content-length") or 0)
                raw = self.rfile.read(length) if length else b""
                body = json.loads(raw) if raw else {}
                path = unquote(urlsplit(self.path).path)
                with fake._lock:
                    fake.requests.append({"path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}, "body": body})
                status, headers, payload = fake.answer(path, body)
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                for k, v in headers.items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        self.host = f"127.0.0.1:{self.port}"
        self.url = f"http://{self.host}"
        self._thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self._thread.start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    # ------------------------------------------------------------------ protocol

    def protocol(self, path: str) -> str:
        if path.endswith("/chat/completions"):
            return "openai"
        if path.endswith("/messages"):
            return "anthropic"
        if ":generateContent" in path:
            return "gemini"
        if path.endswith("/converse"):
            return "bedrock"
        raise ValueError(f"fake provider: no protocol for {path}")

    def answer(self, path: str, body: dict[str, Any]) -> tuple[int, dict[str, str], Any]:
        proto = self.protocol(path)
        if self.fail is not None:
            return self._error(proto, *self.fail)
        if proto == "openai":
            n = sum(1 for m in body.get("messages", []) if m.get("role") == "assistant")
        elif proto == "anthropic":
            n = sum(1 for m in body.get("messages", []) if m.get("role") == "assistant")
        elif proto == "gemini":
            n = sum(1 for c in body.get("contents", []) if c.get("role") == "model")
        else:
            n = sum(1 for m in body.get("messages", []) if m.get("role") == "assistant")
        if n >= len(self.steps):
            return self._error(proto, 400, "script_exhausted")
        step = self.steps[n]
        return 200, {}, getattr(self, f"_{proto}")(step, n)

    def _openai(self, step: dict[str, Any], n: int) -> Any:
        message: dict[str, Any] = {"role": "assistant", "content": step.get("text")}
        if "tool" in step:
            message["tool_calls"] = [
                {"id": f"call_{n}", "type": "function", "function": {"name": step["tool"], "arguments": json.dumps(step.get("args", {}))}}
            ]
        out: dict[str, Any] = {
            "id": f"chatcmpl-{n}",
            "object": "chat.completion",
            "created": 1767225600,
            "choices": [{"index": 0, "message": message, "finish_reason": "tool_calls" if "tool" in step else "stop"}],
            "usage": {"prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18},
        }
        if self.reported_model is not None:
            out["model"] = self.reported_model
        return out

    def _anthropic(self, step: dict[str, Any], n: int) -> Any:
        if "tool" in step:
            content = [{"type": "tool_use", "id": f"toolu_{n}", "name": step["tool"], "input": step.get("args", {})}]
        else:
            content = [{"type": "text", "text": step["text"]}]
        return {
            "id": f"msg_{n}",
            "type": "message",
            "role": "assistant",
            "model": self.reported_model,
            "content": content,
            "stop_reason": "tool_use" if "tool" in step else "end_turn",
            "stop_sequence": None,
            "usage": {"input_tokens": 11, "output_tokens": 7},
        }

    def _gemini(self, step: dict[str, Any], n: int) -> Any:
        part = {"functionCall": {"name": step["tool"], "args": step.get("args", {})}} if "tool" in step else {"text": step["text"]}
        out: dict[str, Any] = {
            "candidates": [{"content": {"role": "model", "parts": [part]}, "finishReason": "STOP", "index": 0}],
            "usageMetadata": {"promptTokenCount": 11, "candidatesTokenCount": 7, "totalTokenCount": 18},
        }
        if self.reported_model is not None:
            out["modelVersion"] = self.reported_model
        return out

    def _bedrock(self, step: dict[str, Any], n: int) -> Any:
        if "tool" in step:
            content = [{"toolUse": {"toolUseId": f"tooluse_{n}", "name": step["tool"], "input": step.get("args", {})}}]
        else:
            content = [{"text": step["text"]}]
        # The real Converse API reports no model id; neither does this.
        return {
            "output": {"message": {"role": "assistant", "content": content}},
            "stopReason": "tool_use" if "tool" in step else "end_turn",
            "usage": {"inputTokens": 11, "outputTokens": 7, "totalTokens": 18},
            "metrics": {"latencyMs": 1},
        }

    def _error(self, proto: str, status: int, code: str) -> tuple[int, dict[str, str], Any]:
        message = f"fake {proto} error {status} {code}"
        if proto == "openai":
            return status, {}, {"error": {"message": message, "type": code, "code": code}}
        if proto == "anthropic":
            return status, {}, {"type": "error", "error": {"type": code, "message": message}}
        if proto == "gemini":
            return status, {}, {"error": {"code": status, "message": message, "status": code}}
        return status, {"x-amzn-errortype": f"{code}:http://internal.amazon.com/coral/com.amazon.bedrock/"}, {"message": message}
