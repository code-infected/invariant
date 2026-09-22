import fs from "node:fs";
import path from "node:path";
import { TASKS_DIR } from "../lib/paths.js";

const EXAMPLE_CONFIG = `providers:
  retry:
    max_attempts: 3
    # HTTP statuses retried as infra flakes, plus "timeout" for provider failures with no
    # HTTP response. 529 is Anthropic's "overloaded" status.
    retry_on: [429, 503, 529, "timeout"]
execution:
  worker_concurrency: 8
  default_tier: smoke
# Every model call the harness makes, by role. model is "provider:model", split on the
# first colon (ollama:qwen2.5:3b is provider ollama, model qwen2.5:3b). Providers:
# anthropic, openai, azure, gemini, bedrock, openai-compatible, and the OpenAI-compatible
# presets openrouter, groq, together, deepseek, mistral, xai, fireworks, ollama, lmstudio,
# vllm. Each reads its conventional key variable (ANTHROPIC_API_KEY, OPENAI_API_KEY,
# GOOGLE_API_KEY or GEMINI_API_KEY, the AWS credential chain, AZURE_OPENAI_API_KEY,
# GROQ_API_KEY, ...); api_key_env: NAME overrides it. Optional per role: base_url,
# api_key_env, params, api_version (azure), region (bedrock). \`invariant doctor\` shows
# what each role resolves to and whether its key is set.
#
# params are sent exactly as written and nothing else is: the harness never sets
# temperature (or anything) on the agent under test unless it is here. The judge's
# temperature is judge.temperature below.
models:
  agent:
    model: anthropic:claude-sonnet-4-5
  judge:
    model: anthropic:claude-sonnet-4-5
  paraphraser:
    model: anthropic:claude-sonnet-4-5
  # Optional embedding pre-filter for the outcome axis (a provider with an embeddings API:
  # openai, azure, gemini, bedrock, or an OpenAI-compatible server such as ollama). Without
  # it, every pair of non-identical answers goes to the judge.
  # embedder:
  #   model: openai:text-embedding-3-small
judge:
  temperature: 0
  votes: 3
  embedding_prefilter_threshold_high: 0.95
  embedding_prefilter_threshold_low: 0.40
`;

export function runInit(): void {
  fs.mkdirSync(TASKS_DIR, { recursive: true });

  const configPath = path.join(path.dirname(TASKS_DIR), "invariant.config.yaml");
  if (fs.existsSync(configPath)) {
    console.log(`invariant.config.yaml already exists, leaving it alone.`);
  } else {
    fs.writeFileSync(configPath, EXAMPLE_CONFIG, "utf8");
    console.log(`Wrote ${path.relative(process.cwd(), configPath)}`);
  }

  console.log(`tasks/ is ready. Add a task with a <name>.yaml spec and a matching`);
  console.log(`<name>.variants.json fixture, then run: invariant validate`);
}
