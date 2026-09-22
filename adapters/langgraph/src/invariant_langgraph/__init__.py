"""invariant-langgraph: run a LangGraph agent through an invariant task.

The adapter drives the user's graph over a task's (variant x trial) cells, records every
tool call through a LangChain callback handler, sandboxes the task's dangerous tools by
wrapping the tool objects, and writes one trial trace file per cell
(schemas/trial-trace.v1.schema.json). It never writes the trace store: `invariant ingest`
imports the files, so the store keeps a single writer.
"""

__version__ = "0.1.0"
ADAPTER_NAME = "invariant-langgraph"
