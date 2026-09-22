import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, maskVolatile, MASKED } from "./mask.js";

describe("volatile-field masking", () => {
  test("replaces volatile values at any depth, keeps the keys, leaves everything else alone", () => {
    const masked = maskVolatile(
      {
        order_id: "1234",
        request_id: "a1",
        meta: { trace_id: "t9", note: "keep" },
        items: [{ timestamp: "2026-09-19T00:00:00Z", sku: "KB-114" }],
      },
      ["request_id", "trace_id", "timestamp"]
    );
    assert.deepEqual(masked, {
      order_id: "1234",
      request_id: MASKED,
      meta: { trace_id: MASKED, note: "keep" },
      items: [{ timestamp: MASKED, sku: "KB-114" }],
    });
  });

  test("matching is by exact key name", () => {
    assert.deepEqual(maskVolatile({ Request_ID: "x", request_id_2: "y" }, ["request_id"]), {
      Request_ID: "x",
      request_id_2: "y",
    });
  });

  test("canonical JSON ignores key order but not value types", () => {
    assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }), canonicalJson({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 }));
    assert.notEqual(canonicalJson({ amount: 42 }), canonicalJson({ amount: "42" }));
    assert.equal(canonicalJson(undefined), "null");
  });
});
