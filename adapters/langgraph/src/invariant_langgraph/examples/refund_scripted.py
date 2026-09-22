"""SYNTHETIC. A scripted reproduction of the Princeton RFC refund scenario, for the adapter.

Same script as packages/cli/src/commands/princeton-fixture.ts, which drives the MCP path:
an airline-style refund agent that, given the identical request five times, refunds 3/5
times and declines 2/5. Here it drives the REAL LangGraph graph in examples/refund.py
(real ToolNode, real tool sandbox, real callback recording); only the model is a script.
It demonstrates that the adapter records this failure shape so the unchanged scoring
engine catches it. It is not evidence about any model.

  trials 1, 3  lookup_order -> process_refund -> reply "refunded"
  trial  5     lookup_order -> check_refund_history -> process_refund -> reply "refunded"
               (sees already_refunded: true and refunds anyway)
  trials 2, 4  lookup_order -> check_refund_history -> reply "already refunded, declined"

Every process_refund call carries a fresh random request_id, so the three refunds only
group together if the task's volatile_fields masking works. Trials past 5 repeat the
pattern (trial t behaves like trial ((t - 1) % 5) + 1).

    invariant-langgraph run --task refund-duplicate-check --tier smoke --variants v1 --trials 5 \\
        --graph invariant_langgraph.examples.refund:build_graph \\
        --tools invariant_langgraph.examples.refund:make_tools \\
        --model-factory invariant_langgraph.examples.refund_scripted:princeton_model --out traces/
"""
from __future__ import annotations

import uuid

from ..driver import CellInfo
from ..scripted import ScriptedChatModel

APPROVING_TRIALS = (1, 3, 5)
APPROVE_REPLIES = {
    1: "Done: I've issued a refund of $42.00 for order #1234 (refund id sandbox-0001).",
    3: "Your refund for order 1234 has been processed, $42.00 back to your original payment method.",
    5: "I've processed a $42.00 refund for order #1234. You should see it in 5-10 business days.",
}
DECLINE_REPLIES = {
    2: "Order #1234 was already refunded ($42.00 on 2026-09-12), so I haven't issued a second refund.",
    4: "It looks like order 1234 already received a full refund of $42.00 on September 12, so no new refund was made.",
}


def princeton_steps(trial: int) -> list[dict]:
    t = (trial - 1) % 5 + 1
    order = {"order_id": "1234"}
    refund = {"order_id": "1234", "amount": 42, "request_id": str(uuid.uuid4())}
    if t in APPROVING_TRIALS:
        middle = [{"tool": "check_refund_history", "args": order}] if t == 5 else []
        return [
            {"tool": "lookup_order", "args": order},
            *middle,
            {"tool": "process_refund", "args": refund},
            {"tool": "reply_to_user", "args": {"message": APPROVE_REPLIES[t]}},
        ]
    return [
        {"tool": "lookup_order", "args": order},
        {"tool": "check_refund_history", "args": order},
        {"tool": "reply_to_user", "args": {"message": DECLINE_REPLIES[t]}},
    ]


def princeton_model(cell: CellInfo) -> ScriptedChatModel:
    """Model factory for the adapter: a fresh script for this cell's trial number."""
    return ScriptedChatModel(steps=princeton_steps(cell.trial))
