import fs from "node:fs";
import { parse as parseYaml } from "yaml";
import { InvariantConfigSchema, type InvariantConfig } from "../schema/config.js";
import { CONFIG_PATH } from "./paths.js";

export type ConfigResult = { ok: true; config: InvariantConfig } | { ok: false; errors: string[] };

export function parseConfig(text: string): ConfigResult {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    return { ok: false, errors: [`not valid YAML: ${(err as Error).message}`] };
  }
  const result = InvariantConfigSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, errors: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  }
  return { ok: true, config: result.data };
}

/** Load and validate invariant.config.yaml at the repo root, or throw with every problem listed. */
export function loadConfig(file: string = CONFIG_PATH): InvariantConfig {
  if (!fs.existsSync(file)) {
    throw new Error(`no invariant.config.yaml at ${file} (run: invariant init)`);
  }
  const result = parseConfig(fs.readFileSync(file, "utf8"));
  if (!result.ok) {
    throw new Error("invariant.config.yaml is not valid:\n" + result.errors.map((e) => `  - ${e}`).join("\n"));
  }
  return result.config;
}
