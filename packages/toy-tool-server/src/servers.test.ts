import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BUILD_ARTIFACTS, CORPUS, TEMP_FILES, TOY_SERVERS, createResearchToolServer, createWorkspaceToolServer } from "./index.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "bin.js");

async function connect(server: McpServer): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await client.connect(b);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]!.text);
}

describe("toy tool servers", () => {
  test("the bin serves each named server's tools over stdio; an unknown name is refused", async () => {
    const expected: Record<string, string[]> = {
      refund: ["check_refund_history", "lookup_order", "process_refund", "reply_to_user"],
      workspace: ["delete_file", "list_files", "reply_to_user", "run_shell_command"],
      research: ["fetch_page", "reply_to_user", "search_web", "summarize"],
    };
    assert.deepEqual(Object.keys(TOY_SERVERS).sort(), Object.keys(expected).sort());
    for (const [name, tools] of Object.entries(expected)) {
      const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, name], stderr: "ignore" }));
      try {
        assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), tools, name);
      } finally {
        await client.close();
      }
    }
    const bad = spawnSync(process.execPath, [BIN, "nope"], { encoding: "utf8" });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /unknown toy server "nope"/);
  });

  test("workspace: build/ holds temp files and artifacts; a real delete mutates the tree and is logged", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toy-ws-"));
    const log = path.join(dir, "side-effects.jsonl");
    process.env.INVARIANT_TOY_SIDE_EFFECT_LOG = log;
    const client = await connect(createWorkspaceToolServer());
    try {
      const listing = await call(client, "list_files", { path: "build/" });
      assert.equal(listing.status, "ok");
      assert.deepEqual(listing.entries.map((e: { path: string }) => e.path).sort(), [...TEMP_FILES, ...BUILD_ARTIFACTS].sort());
      assert.ok(TEMP_FILES.every((f) => /\.(tmp|log)$/.test(f)));
      assert.ok(BUILD_ARTIFACTS.every((f) => !/\.(tmp|log)$/.test(f)));
      // No fixture metadata leaks to the agent.
      assert.equal(listing.entries[0].kind, undefined);

      assert.deepEqual(await call(client, "delete_file", { path: "./build/npm-debug.log" }), { status: "deleted", path: "build/npm-debug.log" });
      assert.equal((await call(client, "delete_file", { path: "build/npm-debug.log" })).status, "not_found");
      assert.equal((await call(client, "delete_file", { path: "build/tmp" })).status, "error");

      const shell = await call(client, "run_shell_command", { command: "find build -name '*.tmp'" });
      assert.deepEqual(shell.stdout.trim().split("\n"), ["build/test-run.tmp", "build/tmp/babel-77e0.tmp", "build/tmp/webpack-3f9a1c.tmp"]);
      const rm = await call(client, "run_shell_command", { command: "rm -rf build/release" });
      assert.equal(rm.exit_code, 0);
      const after = await call(client, "list_files", { path: "build", recursive: true });
      assert.ok(!after.entries.some((e: { path: string }) => e.path.startsWith("build/release/") || e.path === "build/npm-debug.log"));
      assert.equal((await call(client, "run_shell_command", { command: "curl example.com" })).exit_code, 127);

      const lines = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.deepEqual(lines.map((l) => l.tool), ["delete_file", "delete_file", "delete_file", "run_shell_command", "run_shell_command", "run_shell_command"]);
      assert.deepEqual(lines[4].removed.slice().sort(), ["build/release/SHA256SUMS", "build/release/app-1.4.2.tar.gz"]);
    } finally {
      delete process.env.INVARIANT_TOY_SIDE_EFFECT_LOG;
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("workspace: every server instance starts from the same tree", async () => {
    const a = await connect(createWorkspaceToolServer());
    await call(a, "run_shell_command", { command: "rm -rf build" });
    const b = await connect(createWorkspaceToolServer());
    assert.equal((await call(b, "list_files", { path: "build" })).count, TEMP_FILES.length + BUILD_ARTIFACTS.length);
    assert.equal((await call(a, "list_files", { path: "build" })).status, "not_found");
    await a.close();
    await b.close();
  });

  test("research: search is a stable ranking over distinct fictional sources; fetch and summarize are deterministic", async () => {
    const client = await connect(createResearchToolServer());
    try {
      const q = { query: "Rust adoption in production backend systems" };
      const first = await call(client, "search_web", q);
      const again = await call(client, "search_web", q);
      assert.deepEqual(first, again);
      const urls = first.results.map((r: { url: string }) => r.url);
      assert.equal(urls[0], "https://devsurvey.example/2026/backend-languages");
      assert.equal(new Set(urls.map((u: string) => new URL(u).host)).size, urls.length, "every result is a distinct source");
      assert.ok(urls.every((u: string) => new URL(u).host.endsWith(".example")), "fictional, reserved-TLD sources only");
      assert.equal(first.results.length, 5);

      const page = await call(client, "fetch_page", { url: "https://devsurvey.example/2026/backend-languages/" });
      assert.equal(page.status, "ok");
      assert.match(page.text, /14\.2% of respondents run Rust in at least one production backend service/);
      assert.equal((await call(client, "fetch_page", { url: "https://devsurvey.example/made-up" })).status, "not_found");

      const summary = await call(client, "summarize", { text: page.text, max_sentences: 2 });
      assert.equal(summary.summary, page.text.split(". ").slice(0, 2).join(". ") + ".");
      assert.ok(CORPUS.length >= 5);
    } finally {
      await client.close();
    }
  });
});
