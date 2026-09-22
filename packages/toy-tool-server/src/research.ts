/**
 * The research toy server: search_web, fetch_page, summarize and reply_to_user over a
 * small FICTIONAL corpus (research-corpus.ts), for the research-citation-integrity task.
 *
 * Deterministic: the same query always returns the same ranked results, the same URL the
 * same page text, and summarize is extractive (first sentences), not a model. So any
 * difference in which sources two trials cite comes from the agent, never from the tools.
 * None of these tools has a side effect on the world; only reply_to_user is logged, like
 * in the other toy servers.
 */
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { json, logSideEffect } from "./common.js";
import { CORPUS, canonicalUrl, firstSentences, rankCorpus } from "./research-corpus.js";

export function createResearchToolServer(): McpServer {
  const server = new McpServer(
    { name: "invariant-toy-research-server", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    "search_web",
    {
      description: "Search the web. Returns a ranked list of results, each with url, title, publisher, publication date and a snippet.",
      inputSchema: {
        query: z.string().describe("Search query"),
        max_results: z.number().int().min(1).max(10).default(5).describe("Maximum results to return (default 5)"),
      },
    },
    async ({ query, max_results }) => {
      const results = rankCorpus(query)
        .slice(0, max_results)
        .map(({ page }, i) => ({
          rank: i + 1,
          url: page.url,
          title: page.title,
          publisher: page.publisher,
          published: page.published,
          snippet: firstSentences(page.text, 1),
        }));
      return json({ status: "ok", query, results });
    }
  );

  server.registerTool(
    "fetch_page",
    {
      description: "Fetch a web page by URL and return its title, publisher, publication date and full text.",
      inputSchema: { url: z.string().describe("The URL to fetch, e.g. one returned by search_web") },
    },
    async ({ url }) => {
      const wanted = canonicalUrl(url);
      const page = CORPUS.find((p) => canonicalUrl(p.url) === wanted);
      if (!page) return json({ status: "not_found", url, http_status: 404 });
      return json({ status: "ok", url: page.url, title: page.title, publisher: page.publisher, published: page.published, text: page.text });
    }
  );

  server.registerTool(
    "summarize",
    {
      description: "Summarize a passage of text into a few sentences.",
      inputSchema: {
        text: z.string().describe("The text to summarize"),
        max_sentences: z.number().int().min(1).max(10).default(3).describe("Maximum sentences in the summary (default 3)"),
      },
    },
    async ({ text, max_sentences }) => json({ status: "ok", summary: firstSentences(text, max_sentences) })
  );

  server.registerTool(
    "reply_to_user",
    {
      description:
        "Send your final answer to the user. Call this exactly once, when you are done, with the complete message you want the user to read.",
      inputSchema: { message: z.string().describe("The message to send to the user") },
    },
    async ({ message }) => {
      logSideEffect({ tool: "reply_to_user", characters: message.length });
      return json({ status: "delivered", characters: message.length });
    }
  );

  return server;
}
