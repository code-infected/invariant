/**
 * @invariant/trace-store
 *
 * A deliberate local-development substitute for the production trace store described in
 * internal-docs/TECHNICAL_SPEC.md section 7 (Postgres for run/tool-call metadata,
 * S3-compatible object storage for raw trace blobs).
 *
 * There is no database server and no cloud storage in the environment this was built in,
 * and standing up a fake one would be pretending infrastructure exists that doesn't. So:
 * metadata goes in a local SQLite file at <root>/trace.db via better-sqlite3, raw traces
 * go in <root>/traces/<run_id>.json instead of an S3 key. Both are runtime data, not
 * source, and <root> (.invariant/) is gitignored.
 *
 * The schema (src/schema.ts) is kept SQL-portable on purpose: no SQLite-specific types,
 * no engine-generated ids, no SQLite-only functions. Swapping to Postgres means changing
 * the driver and the two or three type mappings listed in schema.ts, not rewriting
 * callers. Likewise writeRawTrace/readRawTrace are the only two places that touch the
 * filesystem, so pointing them at S3 is a single-file change.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "./schema.js";

export { SCHEMA_SQL };

export type RunStatus = "running" | "ok" | "timeout" | "infra_error";

export interface DangerousToolSpec {
  name: string;
  sandbox_response: string;
}

export interface TaskInput {
  name: string;
  prompt_template: string;
  success_rubric: string;
  forbidden_mutations?: unknown;
  dangerous_tools?: unknown;
  volatile_fields?: unknown;
  thresholds: unknown;
  owner?: string | null;
}

export interface VariantInput {
  task_id: string;
  /** The fixture-local id, e.g. "v1". Unique per (task, fixture_version). */
  label: string;
  phrasing_text: string;
  fixture_version: number;
  approved_by?: string | null;
  generated_at?: string | null;
}

export interface RecordRunInput {
  task_id: string;
  variant_id: string;
  trial_number: number;
  deployment_fingerprint?: string | null;
  status?: RunStatus;
}

export interface CompleteRunInput {
  run_id: string;
  status: Exclude<RunStatus, "running">;
  final_output?: string | null;
  latency_ms?: number | null;
  /** Total tokens for the run. Dollar pricing is not modelled yet, see README. */
  token_cost?: number | null;
  trace_blob_ref?: string | null;
}

export interface ToolCallInput {
  run_id: string;
  sequence_index: number;
  tool_name: string;
  args: unknown;
  response: unknown;
  is_sandboxed: boolean;
  called_at: string;
}

export interface TaskRow {
  id: string;
  name: string;
  prompt_template: string;
  success_rubric: string;
  forbidden_mutations: unknown;
  dangerous_tools: unknown;
  volatile_fields: unknown;
  thresholds: unknown;
  owner: string | null;
  created_at: string;
}

export interface VariantRow {
  id: string;
  task_id: string;
  label: string;
  phrasing_text: string;
  fixture_version: number;
  approved_by: string | null;
  generated_at: string | null;
}

export interface RunRow {
  id: string;
  task_id: string;
  variant_id: string;
  trial_number: number;
  deployment_fingerprint: string | null;
  status: RunStatus;
  final_output: string | null;
  latency_ms: number | null;
  token_cost: number | null;
  trace_blob_ref: string | null;
  created_at: string;
}

/** One tool call as specified in internal-docs/TECHNICAL_SPEC.md section 3. */
export interface ToolCallRow {
  run_id: string;
  sequence_index: number;
  tool_name: string;
  args: unknown;
  response: unknown;
  is_sandboxed: boolean;
  timestamp: string;
}

/** A run plus its ordered tool calls: the "trace record" the orchestrator hands back. */
export interface RunRecord {
  run: RunRow;
  task: TaskRow;
  variant: VariantRow;
  tool_calls: ToolCallRow[];
}

export interface TraceStoreOptions {
  /** Directory that holds trace.db and traces/. Defaults to <cwd>/.invariant */
  root?: string;
}

function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function fromJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    // A row written by something other than this package, or hand-edited. Surfacing the
    // raw text beats throwing while reading back a trace for debugging.
    return value;
  }
}

export class TraceStore {
  readonly root: string;
  readonly dbPath: string;
  private readonly db: Database.Database;

  constructor(options: TraceStoreOptions = {}) {
    this.root = path.resolve(options.root ?? path.join(process.cwd(), ".invariant"));
    fs.mkdirSync(path.join(this.root, "traces"), { recursive: true });
    this.dbPath = path.join(this.root, "trace.db");
    this.db = new Database(this.dbPath);
    // WAL so the proxy process and the driver process can write/read the same file
    // concurrently during a trial without blocking each other.
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA_SQL);
  }

  /** Insert or update a task by its unique name. Returns the task id. */
  upsertTask(input: TaskInput): string {
    const existing = this.db.prepare("select id from tasks where name = ?").get(input.name) as
      | { id: string }
      | undefined;
    const id = existing?.id ?? randomUUID();
    if (existing) {
      this.db
        .prepare(
          `update tasks set prompt_template = @prompt_template, success_rubric = @success_rubric,
             forbidden_mutations = @forbidden_mutations, dangerous_tools = @dangerous_tools,
             volatile_fields = @volatile_fields, thresholds = @thresholds, owner = @owner
           where id = @id`
        )
        .run({
          id,
          prompt_template: input.prompt_template,
          success_rubric: input.success_rubric,
          forbidden_mutations: toJson(input.forbidden_mutations ?? []),
          dangerous_tools: toJson(input.dangerous_tools ?? []),
          volatile_fields: toJson(input.volatile_fields ?? []),
          thresholds: toJson(input.thresholds),
          owner: input.owner ?? null,
        });
      return id;
    }
    this.db
      .prepare(
        `insert into tasks (id, name, prompt_template, success_rubric, forbidden_mutations,
           dangerous_tools, volatile_fields, thresholds, owner, created_at)
         values (@id, @name, @prompt_template, @success_rubric, @forbidden_mutations,
           @dangerous_tools, @volatile_fields, @thresholds, @owner, @created_at)`
      )
      .run({
        id,
        name: input.name,
        prompt_template: input.prompt_template,
        success_rubric: input.success_rubric,
        forbidden_mutations: toJson(input.forbidden_mutations ?? []),
        dangerous_tools: toJson(input.dangerous_tools ?? []),
        volatile_fields: toJson(input.volatile_fields ?? []),
        thresholds: toJson(input.thresholds),
        owner: input.owner ?? null,
        created_at: new Date().toISOString(),
      });
    return id;
  }

  /** Insert or update a variant, keyed by (task, fixture_version, label). Returns its id. */
  upsertVariant(input: VariantInput): string {
    const existing = this.db
      .prepare("select id from variants where task_id = ? and fixture_version = ? and label = ?")
      .get(input.task_id, input.fixture_version, input.label) as { id: string } | undefined;
    const id = existing?.id ?? randomUUID();
    if (existing) {
      this.db
        .prepare(
          `update variants set phrasing_text = @phrasing_text, approved_by = @approved_by,
             generated_at = @generated_at where id = @id`
        )
        .run({
          id,
          phrasing_text: input.phrasing_text,
          approved_by: input.approved_by ?? null,
          generated_at: input.generated_at ?? null,
        });
      return id;
    }
    this.db
      .prepare(
        `insert into variants (id, task_id, label, phrasing_text, fixture_version, approved_by, generated_at)
         values (@id, @task_id, @label, @phrasing_text, @fixture_version, @approved_by, @generated_at)`
      )
      .run({
        id,
        task_id: input.task_id,
        label: input.label,
        phrasing_text: input.phrasing_text,
        fixture_version: input.fixture_version,
        approved_by: input.approved_by ?? null,
        generated_at: input.generated_at ?? null,
      });
    return id;
  }

  /** Open a run row. Defaults to status 'running'; call completeRun when the trial ends. */
  recordRun(input: RecordRunInput): string {
    const id = randomUUID();
    this.db
      .prepare(
        `insert into runs (id, task_id, variant_id, trial_number, deployment_fingerprint, status, created_at)
         values (@id, @task_id, @variant_id, @trial_number, @deployment_fingerprint, @status, @created_at)`
      )
      .run({
        id,
        task_id: input.task_id,
        variant_id: input.variant_id,
        trial_number: input.trial_number,
        deployment_fingerprint: input.deployment_fingerprint ?? null,
        status: input.status ?? "running",
        created_at: new Date().toISOString(),
      });
    return id;
  }

  completeRun(input: CompleteRunInput): void {
    const result = this.db
      .prepare(
        `update runs set status = @status, final_output = @final_output, latency_ms = @latency_ms,
           token_cost = @token_cost, trace_blob_ref = @trace_blob_ref where id = @run_id`
      )
      .run({
        run_id: input.run_id,
        status: input.status,
        final_output: input.final_output ?? null,
        latency_ms: input.latency_ms ?? null,
        token_cost: input.token_cost ?? null,
        trace_blob_ref: input.trace_blob_ref ?? null,
      });
    if (result.changes === 0) {
      throw new Error(`completeRun: no run with id ${input.run_id}`);
    }
  }

  recordToolCall(input: ToolCallInput): string {
    const id = randomUUID();
    this.db
      .prepare(
        `insert into tool_calls (id, run_id, sequence_index, tool_name, args_json, response_json, is_sandboxed, called_at)
         values (@id, @run_id, @sequence_index, @tool_name, @args_json, @response_json, @is_sandboxed, @called_at)`
      )
      .run({
        id,
        run_id: input.run_id,
        sequence_index: input.sequence_index,
        tool_name: input.tool_name,
        args_json: toJson(input.args),
        response_json: toJson(input.response),
        is_sandboxed: input.is_sandboxed ? 1 : 0,
        called_at: input.called_at,
      });
    return id;
  }

  getTask(id: string): TaskRow | null {
    const row = this.db.prepare("select * from tasks where id = ?").get(id) as
      | Record<string, string | null>
      | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      name: row.name as string,
      prompt_template: row.prompt_template as string,
      success_rubric: row.success_rubric as string,
      forbidden_mutations: fromJson(row.forbidden_mutations ?? null),
      dangerous_tools: fromJson(row.dangerous_tools ?? null),
      volatile_fields: fromJson(row.volatile_fields ?? null),
      thresholds: fromJson(row.thresholds ?? null),
      owner: (row.owner as string | null) ?? null,
      created_at: row.created_at as string,
    };
  }

  getTaskByName(name: string): TaskRow | null {
    const row = this.db.prepare("select id from tasks where name = ?").get(name) as { id: string } | undefined;
    return row ? this.getTask(row.id) : null;
  }

  getVariant(id: string): VariantRow | null {
    const row = this.db.prepare("select * from variants where id = ?").get(id) as VariantRow | undefined;
    return row ?? null;
  }

  getRun(id: string): RunRow | null {
    const row = this.db.prepare("select * from runs where id = ?").get(id) as RunRow | undefined;
    return row ?? null;
  }

  getToolCalls(runId: string): ToolCallRow[] {
    const rows = this.db
      .prepare("select * from tool_calls where run_id = ? order by sequence_index asc")
      .all(runId) as Array<Record<string, string | number | null>>;
    return rows.map((row) => ({
      run_id: row.run_id as string,
      sequence_index: row.sequence_index as number,
      tool_name: row.tool_name as string,
      args: fromJson((row.args_json as string | null) ?? null),
      response: fromJson((row.response_json as string | null) ?? null),
      is_sandboxed: row.is_sandboxed === 1,
      timestamp: row.called_at as string,
    }));
  }

  /** A run plus everything needed to read it on its own: task, variant, ordered tool calls. */
  getRunRecord(runId: string): RunRecord | null {
    const run = this.getRun(runId);
    if (!run) return null;
    const task = this.getTask(run.task_id);
    const variant = this.getVariant(run.variant_id);
    if (!task || !variant) return null;
    return { run, task, variant, tool_calls: this.getToolCalls(runId) };
  }

  /**
   * Write the full raw trace blob. Returns the ref stored in runs.trace_blob_ref, which
   * is relative to the store root on purpose so the same ref shape works when the backing
   * store becomes an S3 key.
   */
  writeRawTrace(runId: string, payload: unknown): string {
    const ref = path.posix.join("traces", `${runId}.json`);
    fs.writeFileSync(this.resolveTraceRef(ref), JSON.stringify(payload, null, 2) + "\n", "utf8");
    return ref;
  }

  readRawTrace(ref: string): unknown {
    return JSON.parse(fs.readFileSync(this.resolveTraceRef(ref), "utf8"));
  }

  resolveTraceRef(ref: string): string {
    return path.join(this.root, ref);
  }

  close(): void {
    this.db.close();
  }
}

export function openTraceStore(options: TraceStoreOptions = {}): TraceStore {
  return new TraceStore(options);
}
