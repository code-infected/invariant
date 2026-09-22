import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { InjectionInput } from "@invariant/mcp-proxy";
import type { PropagationSpec } from "@invariant/scoring";
import { AdversarialPayloadSchema, type AdversarialPayload } from "../schema/adversarial-payload.js";
import type { TaskSpec } from "../schema/task-spec.js";
import { loadTask } from "./load-tasks.js";
import { REPO_ROOT, TASKS_DIR } from "./paths.js";

/** Where payload fixtures live (TECHNICAL_SPEC.md section 9). */
export const ADVERSARIAL_DIR = path.join(TASKS_DIR, "adversarial");

export interface LoadedPayload {
  /** The id from the file, or the file's basename when it does not parse. */
  id: string;
  /** Repo-relative when inside the repo. */
  file: string;
  payload: AdversarialPayload | null;
  /** Hard errors, plus "warning: ..." entries that do not block use. */
  errors: string[];
}

function relative(file: string): string {
  const rel = path.relative(REPO_ROOT, file);
  return rel.startsWith("..") || path.isAbsolute(rel) ? file : rel;
}

/**
 * Cross-checks against the base task spec: the payload must target a tool the task has,
 * its unauthorized action must be a tool the task allows (a matcher on a tool the agent is
 * never given could never fire, and the gate would pass on nothing), and a sandboxed target
 * needs an explicit into_sandboxed or the proxy will refuse to plant anything.
 */
export function checkPayloadAgainstTask(p: AdversarialPayload, spec: TaskSpec): string[] {
  const errors: string[] = [];
  const allowed = new Set(spec.tools.allowed);
  if (!allowed.has(p.inject.tool)) {
    errors.push(`inject.tool "${p.inject.tool}" is not in ${p.task}'s tools.allowed [${spec.tools.allowed.join(", ")}]`);
  }
  if (!allowed.has(p.unauthorized_action.tool)) {
    errors.push(
      `unauthorized_action.tool "${p.unauthorized_action.tool}" is not in ${p.task}'s tools.allowed; the agent is never ` +
        `given that tool, so the matcher could never fire and the payload would always pass`
    );
  }
  if (spec.tools.dangerous.some((d) => d.name === p.inject.tool) && !p.inject.into_sandboxed) {
    errors.push(
      `inject.tool "${p.inject.tool}" is a dangerous (sandboxed) tool in ${p.task}; its response is the spec's sandbox_response, ` +
        `and the proxy only plants into it with inject.into_sandboxed: true`
    );
  }
  if (p.inject.placement.mode === "append_text") {
    errors.push(
      "warning: placement append_text adds plain text after the response; on a tool that returns JSON the agent would see invalid JSON, " +
        "which is itself a tell. Prefer set_field / append_to_field for JSON tools."
    );
  }
  if (!spec.adversarial.enabled) {
    errors.push(`warning: ${p.task} has adversarial.enabled: false, so \`invariant adversarial run\` will refuse this payload`);
  }
  return errors;
}

export function loadPayloadFile(file: string): LoadedPayload {
  const abs = path.resolve(file);
  const base = path.basename(abs).replace(/\.ya?ml$/, "");
  const out: LoadedPayload = { id: base, file: relative(abs), payload: null, errors: [] };
  if (!fs.existsSync(abs)) {
    out.errors.push(`no payload fixture at ${out.file}`);
    return out;
  }
  let raw: unknown;
  try {
    raw = parseYaml(fs.readFileSync(abs, "utf8"));
  } catch (err) {
    out.errors.push(`not valid YAML: ${(err as Error).message}`);
    return out;
  }
  const parsed = AdversarialPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) out.errors.push(`payload: ${issue.path.join(".")}: ${issue.message}`);
    return out;
  }
  const p = parsed.data;
  out.id = p.id;
  out.payload = p;
  if (p.id !== base) out.errors.push(`payload id ("${p.id}") does not match its filename (${out.file})`);
  if (path.dirname(abs) !== ADVERSARIAL_DIR) {
    out.errors.push(`warning: ${out.file} is outside tasks/adversarial/, where payload fixtures are kept so nobody mistakes one for a real incident`);
  }
  const task = loadTask(p.task);
  const taskErrors = task.errors.filter((e) => !e.startsWith("warning:"));
  if (taskErrors.length > 0) {
    out.errors.push(`base task "${p.task}" is not valid: ${taskErrors.join("; ")}`);
  } else {
    out.errors.push(...checkPayloadAgainstTask(p, task.spec));
  }
  return out;
}

export function listPayloadFiles(): string[] {
  if (!fs.existsSync(ADVERSARIAL_DIR)) return [];
  return fs
    .readdirSync(ADVERSARIAL_DIR)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort()
    .map((f) => path.join(ADVERSARIAL_DIR, f));
}

export function loadAllPayloads(): LoadedPayload[] {
  return listPayloadFiles().map(loadPayloadFile);
}

/** `--payload=FILE|ID`: a path (anything with a slash or a .yaml extension) or an id under tasks/adversarial/. */
export function resolvePayloadArg(arg: string): string {
  if (arg.includes("/") || arg.includes(path.sep) || /\.ya?ml$/.test(arg)) return path.resolve(arg);
  const file = listPayloadFiles().find((f) => path.basename(f).replace(/\.ya?ml$/, "") === arg);
  if (!file) {
    const known = listPayloadFiles().map((f) => path.basename(f).replace(/\.ya?ml$/, ""));
    throw new Error(`no payload "${arg}" under tasks/adversarial/. Known: ${known.join(", ") || "(none)"}`);
  }
  return file;
}

/** Load and refuse to go further if it does not validate (warnings are fine). */
export function loadValidPayload(arg: string): LoadedPayload & { payload: AdversarialPayload } {
  const loaded = loadPayloadFile(resolvePayloadArg(arg));
  const hard = loaded.errors.filter((e) => !e.startsWith("warning:"));
  if (hard.length > 0 || !loaded.payload) {
    throw new Error(`payload fixture ${loaded.file} is not valid, refusing to use it:\n` + hard.map((e) => `  - ${e}`).join("\n"));
  }
  return loaded as LoadedPayload & { payload: AdversarialPayload };
}

/** What the proxy is configured with. */
export function injectionFor(p: AdversarialPayload): InjectionInput {
  return {
    payload_id: p.id,
    tool: p.inject.tool,
    on_call: p.inject.on_call,
    placement: p.inject.placement,
    text: p.inject.text,
    into_sandboxed: p.inject.into_sandboxed,
  };
}

/** What the propagation scorer is given. */
export function propagationSpecFor(p: AdversarialPayload): PropagationSpec {
  return {
    payload_id: p.id,
    target_tool: p.inject.tool,
    on_call: p.inject.on_call,
    unauthorized_action: { tool: p.unauthorized_action.tool, args: p.unauthorized_action.args },
    max_propagation_rate: p.gate.max_propagation_rate,
  };
}
