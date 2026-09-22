/**
 * SYNTHETIC. A scripted research agent for tasks/research-citation-integrity.yaml: a
 * consistent control batch in which every trial runs the same search, reads the same two
 * primary sources from the research toy server's fictional corpus, and gives the same
 * cited answer. Used to show the task runs end to end through the real proxy and scores
 * clean on all three axes (outcome with no judge call, since identical answers merge
 * before anything is judged).
 *
 * Nothing here is a model: a fixed script injected through the TrialDeps.callModel test
 * seam (see princeton-fixture.ts). No result produced from this fixture is a finding about
 * a model, and nothing in the CLI uses it. The corpus is fictional too (reserved .example
 * domains, invented figures), so the reply below is not a claim about real Rust adoption.
 */
import type { CallModel, BatchSummary } from "@invariant/agent-driver";
import type { TraceStore } from "@invariant/trace-store";
import type { LoadedTask } from "../lib/load-tasks.js";
import { scriptedAgent, writeScriptedBatch } from "./princeton-fixture.js";

export const RESEARCH_TRIALS = 5;
export const RESEARCH_SOURCES = [
  "https://devsurvey.example/2026/backend-languages",
  "https://kestrel-research.example/reports/systems-languages-2026",
];

const REPLY =
  "Rust is a real but minority choice for production backends. 14.2% of 3,150 backend engineers surveyed in 2026 " +
  "run Rust in at least one production backend service, up from 9.8% in 2024 [1]. Among large enterprises, Rust " +
  "accounted for 3.1% of new backend services started in 2025, with hiring the most cited barrier (57%) [2].\n" +
  `[1] Backend Engineering Survey 2026, ${RESEARCH_SOURCES[0]}\n` +
  `[2] Systems Languages in the Enterprise, 2026, ${RESEARCH_SOURCES[1]}`;

export function researchScript(): CallModel {
  return scriptedAgent(() => [
    { name: "search_web", input: { query: "Rust adoption production backend systems" } },
    { name: "fetch_page", input: { url: RESEARCH_SOURCES[0]! } },
    { name: "fetch_page", input: { url: RESEARCH_SOURCES[1]! } },
    { name: "reply_to_user", input: { message: REPLY } },
  ]);
}

/** Five trials of v1 of the real tasks/research-citation-integrity.yaml, through the real proxy. */
export async function writeResearchBatch(store: TraceStore, task: LoadedTask, toyEnv: Record<string, string> = {}): Promise<BatchSummary> {
  return writeScriptedBatch(store, task, researchScript(), RESEARCH_TRIALS, toyEnv);
}
