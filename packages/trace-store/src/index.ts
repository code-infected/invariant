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
import { POST_MIGRATION_SQL, REQUIRED_TABLES, RUNS_MIGRATIONS, SCHEMA_SQL, TABLE_MIGRATIONS } from "./schema.js";
import {
  compareDeployments,
  FINGERPRINT_COMPONENTS,
  isScriptedStandIn,
  type DeploymentFingerprint,
  type FingerprintComponent,
} from "./fingerprint.js";

export { SCHEMA_SQL };
export {
  computeDeploymentFingerprint,
  computeDeploymentFingerprintV1,
  compareDeployments,
  normalizeEndpoint,
  FINGERPRINT_COMPONENTS,
  FINGERPRINT_VERSION,
  FINGERPRINT_FORMAT_V1,
  type DeploymentComparison,
  changedComponents,
  canonicalJson,
  isScriptedStandIn,
  SCRIPTED_STAND_IN_MARKER,
  FINGERPRINT_FORMAT,
  type DeploymentFingerprint,
  type FingerprintInput,
  type FingerprintComponent,
} from "./fingerprint.js";

export type RunStatus = "running" | "ok" | "timeout" | "infra_error";

export type Tier = "smoke" | "full";

/**
 * consistency  an ordinary fan-out, scored on the three consistency axes.
 * adversarial  a fan-out with a planted instruction (ARCHITECTURE.md section 4), scored
 *              only for injection propagation. Never mixed into consistency readers.
 */
export type BatchKind = "consistency" | "adversarial";

export interface CreateBatchInput {
  task_id: string;
  tier: Tier;
  trials_per_variant: number;
  /** What the tier asked for; may exceed variant_labels.length when the fixture is short. */
  variants_requested: number;
  /** Fixture labels actually run, in fixture order. */
  variant_labels: string[];
  /** Defaults to "consistency". */
  kind?: BatchKind;
  /** Adversarial batches only: the payload fixture's id. */
  payload_id?: string | null;
  /** Adversarial batches only: a snapshot of the payload as it was run. Stored as JSON. */
  adversarial_payload?: unknown;
}

export interface BatchRow {
  id: string;
  task_id: string;
  tier: Tier;
  trials_per_variant: number;
  variants_requested: number;
  variant_labels: string[];
  created_at: string;
  finished_at: string | null;
  kind: BatchKind;
  payload_id: string | null;
  adversarial_payload: unknown;
}

export interface RecordScoreInput {
  task_id: string;
  evaluation_batch_id: string;
  /** Null when the axis was not computed or had too few runs. */
  outcome_consistency: number | null;
  tool_path_consistency: number | null;
  state_mutation_consistency: number | null;
  /** Adversarial mode only; null otherwise. */
  injection_propagated?: boolean | null;
  runs_scored: number;
  /** Everything needed to explain the numbers later. Stored as JSON. */
  details: unknown;
}

export interface ScoreRow {
  id: string;
  task_id: string;
  evaluation_batch_id: string;
  outcome_consistency: number | null;
  tool_path_consistency: number | null;
  state_mutation_consistency: number | null;
  injection_propagated: boolean | null;
  runs_scored: number;
  details: unknown;
  computed_at: string;
}

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
  /** Set for runs that belong to a fan-out batch; null for single-trial debugging runs. */
  batch_id?: string | null;
  /** 1 for the first try at a (variant, trial) cell, incremented per infra retry. */
  attempt?: number;
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
  /** Set when the proxy planted this payload's text into the response (adversarial mode). */
  injection_payload_id?: string | null;
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
  batch_id: string | null;
  trial_number: number;
  attempt: number;
  /** True when an infra retry replaced this attempt; it is evidence, not part of the matrix. */
  superseded: boolean;
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
  /** Adversarial mode: the proxy modified this call's response before the agent saw it. */
  is_injected: boolean;
  /** The payload whose text was planted, when is_injected. */
  injection_payload_id: string | null;
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
  /**
   * Open an existing trace.db without writing anything: no directory creation, no schema
   * creation, no migration. For readers such as the dashboard. A missing file throws
   * StoreNotFoundError; a store whose schema predates this code throws
   * StoreOutdatedError (open it once with a writing command to migrate it).
   */
  readonly?: boolean;
}

export class StoreNotFoundError extends Error {
  constructor(readonly dbPath: string) {
    super(`no trace store at ${dbPath}`);
    this.name = "StoreNotFoundError";
  }
}

export class StoreOutdatedError extends Error {
  constructor(
    readonly dbPath: string,
    readonly missing: string[]
  ) {
    super(
      `trace store ${dbPath} predates this version of invariant (missing: ${missing.join(", ")}). ` +
        `Any writing command (e.g. invariant score) migrates it in place; a read-only open never does.`
    );
    this.name = "StoreOutdatedError";
  }
}

/** A stored fingerprint row: the computed fingerprint plus when this store first saw it. */
export interface FingerprintRow extends DeploymentFingerprint {
  first_seen_at: string;
}

/** How many of a batch's matrix runs carry each fingerprint; hash null = not recorded. */
export interface BatchFingerprintCount {
  hash: string | null;
  runs: number;
}

export interface BatchDeploymentFingerprint {
  hash: string;
  runs: number;
  fingerprint_version: number | null;
  provider: string | null;
  endpoint: string | null;
  model_name: string | null;
  model_version: string | null;
  /** The reported model is the scripted stand-in: SYNTHETIC runs, not a model. */
  synthetic: boolean;
}

/** The deployment picture of one batch's run matrix. */
export interface BatchDeployment {
  /** Distinct fingerprints across the matrix, most runs first. */
  fingerprints: BatchDeploymentFingerprint[];
  /** Matrix runs with no fingerprint: no model response arrived, or the run predates fingerprinting. */
  runs_without_fingerprint: number;
  /**
   * The deployment changed during the batch: some recorded component differs between two
   * of its fingerprints. Two hashes that differ only because they were computed with
   * different fingerprint formulas are NOT mixed (see formula_only).
   */
  mixed: boolean;
  /** Components that differ between any fingerprint and the most common one. */
  changed: FingerprintComponent[];
  /** Fingerprint formula versions present, ascending. */
  formula_versions: number[];
  /** More than one hash, but only because of a formula change: the same deployment. */
  formula_only: boolean;
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

type RawRunRow = Omit<RunRow, "superseded"> & { superseded: number };

function toRunRow(row: RawRunRow): RunRow {
  return { ...row, superseded: row.superseded === 1 };
}

export class TraceStore {
  readonly root: string;
  readonly dbPath: string;
  private readonly db: Database.Database;

  readonly isReadOnly: boolean;

  constructor(options: TraceStoreOptions = {}) {
    this.root = path.resolve(options.root ?? path.join(process.cwd(), ".invariant"));
    this.dbPath = path.join(this.root, "trace.db");
    this.isReadOnly = options.readonly === true;
    if (this.isReadOnly) {
      if (!fs.existsSync(this.dbPath)) throw new StoreNotFoundError(this.dbPath);
      this.db = new Database(this.dbPath, { readonly: true, fileMustExist: true });
      this.db.pragma("busy_timeout = 15000");
      const missing = this.missingSchema();
      if (missing.length > 0) {
        this.db.close();
        throw new StoreOutdatedError(this.dbPath, missing);
      }
      return;
    }
    fs.mkdirSync(path.join(this.root, "traces"), { recursive: true });
    this.db = new Database(this.dbPath);
    // WAL so the proxy process and the driver process can write/read the same file
    // concurrently during a trial without blocking each other.
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    // better-sqlite3's default busy timeout is 5s. A fan-out has one driver connection
    // plus one proxy connection per in-flight trial all writing short transactions to
    // this file, so give contention more headroom than a single trial ever needed.
    this.db.pragma("busy_timeout = 15000");
    this.db.exec(SCHEMA_SQL);
    this.migrate();
  }

  /** Tables and migrated columns this code needs that the open file lacks. */
  private missingSchema(): string[] {
    const tables = new Set(
      (this.db.prepare("select name from sqlite_master where type = 'table'").all() as Array<{ name: string }>).map((t) => t.name)
    );
    const missing = REQUIRED_TABLES.filter((t) => !tables.has(t));
    if (tables.has("runs")) {
      const columns = new Set((this.db.prepare("pragma table_info(runs)").all() as Array<{ name: string }>).map((c) => c.name));
      for (const m of RUNS_MIGRATIONS) if (!columns.has(m.column)) missing.push(`runs.${m.column}`);
    }
    for (const m of TABLE_MIGRATIONS) {
      if (!tables.has(m.table)) continue;
      if (!this.columnsOf(m.table).has(m.column)) missing.push(`${m.table}.${m.column}`);
    }
    return missing;
  }

  private columnsOf(table: string): Set<string> {
    return new Set((this.db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
  }

  private migrate(): void {
    // IMMEDIATE takes the write lock before the column check, so two processes opening
    // an old trace.db at the same moment cannot both decide to add the same column.
    this.db
      .transaction(() => {
        const columns = new Set(
          (this.db.prepare("pragma table_info(runs)").all() as Array<{ name: string }>).map((c) => c.name)
        );
        for (const m of RUNS_MIGRATIONS) {
          if (!columns.has(m.column)) this.db.exec(m.ddl);
        }
        for (const m of TABLE_MIGRATIONS) {
          if (!this.columnsOf(m.table).has(m.column)) this.db.exec(m.ddl);
        }
        this.db.exec(POST_MIGRATION_SQL);
      })
      .immediate();
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

  /** Open a batch row for one fan-out (one task, one tier). */
  createBatch(input: CreateBatchInput): string {
    const id = randomUUID();
    this.db
      .prepare(
        `insert into batches (id, task_id, tier, trials_per_variant, variants_requested, variant_labels, created_at,
           kind, payload_id, adversarial_payload)
         values (@id, @task_id, @tier, @trials_per_variant, @variants_requested, @variant_labels, @created_at,
           @kind, @payload_id, @adversarial_payload)`
      )
      .run({
        id,
        task_id: input.task_id,
        tier: input.tier,
        trials_per_variant: input.trials_per_variant,
        variants_requested: input.variants_requested,
        variant_labels: toJson(input.variant_labels),
        created_at: new Date().toISOString(),
        kind: input.kind ?? "consistency",
        payload_id: input.payload_id ?? null,
        adversarial_payload: input.adversarial_payload === undefined ? null : toJson(input.adversarial_payload),
      });
    return id;
  }

  finishBatch(batchId: string): void {
    const result = this.db
      .prepare("update batches set finished_at = ? where id = ?")
      .run(new Date().toISOString(), batchId);
    if (result.changes === 0) throw new Error(`finishBatch: no batch with id ${batchId}`);
  }

  getBatch(id: string): BatchRow | null {
    const row = this.db.prepare("select * from batches where id = ?").get(id) as
      | (Omit<BatchRow, "variant_labels" | "adversarial_payload"> & { variant_labels: string; adversarial_payload: string | null })
      | undefined;
    if (!row) return null;
    return {
      ...row,
      variant_labels: fromJson(row.variant_labels) as string[],
      adversarial_payload: fromJson(row.adversarial_payload),
    };
  }

  /**
   * The runs of a batch. By default only the matrix itself (one row per cell, superseded
   * infra attempts excluded); pass includeSuperseded to also get the retried attempts.
   */
  getBatchRuns(batchId: string, options: { includeSuperseded?: boolean } = {}): RunRow[] {
    const sql = options.includeSuperseded
      ? "select * from runs where batch_id = ? order by trial_number, variant_id, attempt"
      : "select * from runs where batch_id = ? and superseded = 0 order by trial_number, variant_id";
    return (this.db.prepare(sql).all(batchId) as RawRunRow[]).map(toRunRow);
  }

  /**
   * The task's most recent batch of one kind (default: consistency) by creation time. With
   * finishedOnly, skips batches still in flight (or whose process died before
   * finishBatch), whose matrix may be partial. With payloadId (adversarial batches), only
   * that payload's batches count.
   */
  getLatestBatch(
    taskId: string,
    options: { finishedOnly?: boolean; kind?: BatchKind; payloadId?: string } = {}
  ): BatchRow | null {
    const where = ["task_id = @task_id", "kind = @kind"];
    if (options.finishedOnly) where.push("finished_at is not null");
    if (options.payloadId !== undefined) where.push("payload_id = @payload_id");
    const row = this.db
      .prepare(`select id from batches where ${where.join(" and ")} order by created_at desc, rowid desc limit 1`)
      .get({ task_id: taskId, kind: options.kind ?? "consistency", payload_id: options.payloadId ?? null }) as { id: string } | undefined;
    return row ? this.getBatch(row.id) : null;
  }

  /** Append one scoring of a batch. Earlier scorings of the same batch are kept as history. */
  recordScore(input: RecordScoreInput): string {
    const id = randomUUID();
    this.db
      .prepare(
        `insert into scores (id, task_id, evaluation_batch_id, outcome_consistency, tool_path_consistency,
           state_mutation_consistency, injection_propagated, runs_scored, details, computed_at)
         values (@id, @task_id, @evaluation_batch_id, @outcome_consistency, @tool_path_consistency,
           @state_mutation_consistency, @injection_propagated, @runs_scored, @details, @computed_at)`
      )
      .run({
        id,
        task_id: input.task_id,
        evaluation_batch_id: input.evaluation_batch_id,
        outcome_consistency: input.outcome_consistency,
        tool_path_consistency: input.tool_path_consistency,
        state_mutation_consistency: input.state_mutation_consistency,
        injection_propagated:
          input.injection_propagated === undefined || input.injection_propagated === null
            ? null
            : input.injection_propagated
              ? 1
              : 0,
        runs_scored: input.runs_scored,
        details: toJson(input.details),
        // Millisecond ISO timestamps can collide for two scorings in the same ms; the
        // insertion-order tiebreak in getScores keeps "newest first" well defined anyway.
        computed_at: new Date().toISOString(),
      });
    return id;
  }

  /** Every scoring of a batch, newest first. */
  getScores(batchId: string): ScoreRow[] {
    const rows = this.db
      .prepare("select * from scores where evaluation_batch_id = ? order by computed_at desc, rowid desc")
      .all(batchId) as Array<Omit<ScoreRow, "details" | "injection_propagated"> & { details: string; injection_propagated: number | null }>;
    return rows.map((row) => ({
      ...row,
      injection_propagated: row.injection_propagated === null ? null : row.injection_propagated === 1,
      details: fromJson(row.details),
    }));
  }

  /** Flag an attempt as replaced by an infra retry. Only a completed infra_error may be. */
  markSuperseded(runId: string): void {
    const result = this.db
      .prepare("update runs set superseded = 1 where id = ? and status = 'infra_error'")
      .run(runId);
    if (result.changes === 0) {
      // Superseding anything else would drop a behavioural answer out of the matrix,
      // which is precisely the thing the retry policy must never do.
      throw new Error(`markSuperseded: run ${runId} does not exist or is not an infra_error`);
    }
  }

  /** Open a run row. Defaults to status 'running'; call completeRun when the trial ends. */
  recordRun(input: RecordRunInput): string {
    const id = randomUUID();
    this.db
      .prepare(
        `insert into runs (id, task_id, variant_id, batch_id, trial_number, attempt, deployment_fingerprint, status, created_at)
         values (@id, @task_id, @variant_id, @batch_id, @trial_number, @attempt, @deployment_fingerprint, @status, @created_at)`
      )
      .run({
        id,
        task_id: input.task_id,
        variant_id: input.variant_id,
        batch_id: input.batch_id ?? null,
        trial_number: input.trial_number,
        attempt: input.attempt ?? 1,
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
        `insert into tool_calls (id, run_id, sequence_index, tool_name, args_json, response_json, is_sandboxed, called_at,
           is_injected, injection_payload_id)
         values (@id, @run_id, @sequence_index, @tool_name, @args_json, @response_json, @is_sandboxed, @called_at,
           @is_injected, @injection_payload_id)`
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
        is_injected: input.injection_payload_id ? 1 : 0,
        injection_payload_id: input.injection_payload_id ?? null,
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
    const row = this.db.prepare("select * from runs where id = ?").get(id) as RawRunRow | undefined;
    return row ? toRunRow(row) : null;
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
      is_injected: row.is_injected === 1,
      injection_payload_id: (row.injection_payload_id as string | null) ?? null,
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

  // ------------------------------------------------------------ deployment fingerprints

  /**
   * Save a fingerprint (content-addressed: a hash already stored is left as it is, keeping
   * its first_seen_at). Returns the hash.
   */
  recordDeploymentFingerprint(fp: DeploymentFingerprint): string {
    this.db
      .prepare(
        `insert into deployment_fingerprints (hash, fingerprint_version, provider, endpoint, model_name, model_version,
           system_prompt_hash, tool_schema_hash, system_prompt, tool_schema_json, first_seen_at)
         values (@hash, @fingerprint_version, @provider, @endpoint, @model_name, @model_version,
           @system_prompt_hash, @tool_schema_hash, @system_prompt, @tool_schema_json, @first_seen_at)
         on conflict (hash) do nothing`
      )
      .run({ ...fp, first_seen_at: new Date().toISOString() });
    return fp.hash;
  }

  /** Point a run at its fingerprint. The fingerprint must already be recorded. */
  setRunFingerprint(runId: string, hash: string): void {
    if (!this.getDeploymentFingerprint(hash)) {
      throw new Error(`setRunFingerprint: fingerprint ${hash} is not recorded; call recordDeploymentFingerprint first`);
    }
    const result = this.db.prepare("update runs set deployment_fingerprint = ? where id = ?").run(hash, runId);
    if (result.changes === 0) throw new Error(`setRunFingerprint: no run with id ${runId}`);
  }

  getDeploymentFingerprint(hash: string): FingerprintRow | null {
    return (this.db.prepare("select * from deployment_fingerprints where hash = ?").get(hash) as FingerprintRow | undefined) ?? null;
  }

  /** Every fingerprint, oldest first. */
  listDeploymentFingerprints(): FingerprintRow[] {
    return this.db.prepare("select * from deployment_fingerprints order by first_seen_at, hash").all() as FingerprintRow[];
  }

  /**
   * Fingerprints across a batch's run matrix (superseded attempts excluded), most runs
   * first. More than one non-null hash means the deployment changed mid-batch.
   */
  getBatchFingerprints(batchId: string): BatchFingerprintCount[] {
    return this.db
      .prepare(
        // Ties broken by first appearance (rowid: insertion order; created_at is only ms-precise).
        `select deployment_fingerprint as hash, count(*) as runs, min(rowid) as first
           from runs where batch_id = ? and superseded = 0
           group by deployment_fingerprint order by runs desc, first asc`
      )
      .all(batchId)
      .map((r) => ({ hash: (r as BatchFingerprintCount).hash, runs: (r as BatchFingerprintCount).runs }));
  }

  /** Fingerprints across a batch's matrix, with their models and what differs between them. */
  getBatchDeployment(batchId: string): BatchDeployment {
    const fingerprints: BatchDeploymentFingerprint[] = [];
    const rows: FingerprintRow[] = [];
    let without = 0;
    for (const c of this.getBatchFingerprints(batchId)) {
      if (c.hash === null) {
        without += c.runs;
        continue;
      }
      const row = this.getDeploymentFingerprint(c.hash);
      if (row) rows.push(row);
      fingerprints.push({
        hash: c.hash,
        runs: c.runs,
        fingerprint_version: row?.fingerprint_version ?? null,
        provider: row?.provider ?? null,
        endpoint: row?.endpoint ?? null,
        model_name: row?.model_name ?? null,
        model_version: row?.model_version ?? null,
        synthetic: isScriptedStandIn(row?.model_version),
      });
    }
    const changed = new Set<FingerprintComponent>();
    for (const other of rows.slice(1)) for (const c of compareDeployments(rows[0]!, other).changed) changed.add(c);
    // A fingerprint row that is missing cannot be compared: counted as a change, not waved through.
    const missingRow = rows.length < fingerprints.length;
    const mixed = fingerprints.length > 1 && (changed.size > 0 || missingRow);
    return {
      fingerprints,
      runs_without_fingerprint: without,
      mixed,
      changed: FINGERPRINT_COMPONENTS.filter((c) => changed.has(c)),
      formula_versions: [...new Set(rows.map((r) => r.fingerprint_version ?? 1))].sort((a, b) => a - b),
      formula_only: fingerprints.length > 1 && !mixed,
    };
  }

  // ------------------------------------------------------------ listings (for readers)

  /** Every task in the store, by name. */
  listTasks(): TaskRow[] {
    const ids = this.db.prepare("select id from tasks order by name").all() as Array<{ id: string }>;
    return ids.map((r) => this.getTask(r.id)!);
  }

  /**
   * A task's batches of one kind, oldest first (the order a trend reads in). Defaults to
   * consistency batches, so no consistency reader ever sees an adversarial batch by accident.
   */
  listBatches(taskId: string, options: { kind?: BatchKind } = {}): BatchRow[] {
    const ids = this.db
      .prepare("select id from batches where task_id = ? and kind = ? order by created_at, rowid")
      .all(taskId, options.kind ?? "consistency") as Array<{ id: string }>;
    return ids.map((r) => this.getBatch(r.id)!);
  }

  close(): void {
    this.db.close();
  }
}

export function openTraceStore(options: TraceStoreOptions = {}): TraceStore {
  return new TraceStore(options);
}
