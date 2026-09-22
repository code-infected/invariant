/**
 * SQLite DDL, kept deliberately close to the Postgres DDL sketch in
 * internal-docs/TECHNICAL_SPEC.md section 7 so that swapping the backend later is
 * mechanical rather than a rewrite. Where SQLite has no equivalent type, the closest
 * portable choice is used and noted:
 *
 *   uuid         -> TEXT  (generated with crypto.randomUUID() in JS, not by the engine)
 *   jsonb        -> TEXT  (JSON.stringify'd; read back through JSON.parse)
 *   timestamptz  -> TEXT  (ISO 8601, always UTC)
 *   numeric      -> REAL
 *   boolean      -> INTEGER 0/1
 *
 * Two deliberate departures from the DDL sketch, both documented in the package README
 * comment (src/index.ts):
 *   - runs.status also allows 'running', because a run row has to exist before its
 *     tool_calls rows can reference it, and a trial in flight is neither ok, timeout,
 *     nor infra_error. The Postgres check constraint should gain it too.
 *   - variants.label holds the fixture-local variant id ("v1", "v3"). The uuid is the
 *     foreign key, but the fixture label is the handle humans and reports use, and it
 *     has to survive into the trace record.
 *
 *   - batches, plus runs.batch_id / runs.attempt / runs.superseded, exist so one fan-out
 *     (M trials x N variants, TECHNICAL_SPEC.md section 4's batch_id) is addressable as a
 *     unit, and so an infra-flake retry never silently replaces the evidence of the failed
 *     attempt. Every attempt is its own run row with its own tool_calls; a retried attempt
 *     is flagged superseded = 1. The run matrix a scorer should read is therefore exactly
 *     "runs where batch_id = ? and superseded = 0", one row per (variant, trial) cell.
 *     Single-trial debugging runs have batch_id null.
 *
 *   - scores follows the section 7 sketch, with evaluation_batch_id referencing batches
 *     and two additions: runs_scored (the denominator, since runs without a behavioural
 *     answer are excluded from scoring) and details (JSON: groups, clusters, judged
 *     pairs, thresholds and verdicts, so a score can be explained after the fact without
 *     re-running the judge). A score column is null when that axis could not be computed
 *     (e.g. no judge key for the outcome axis) or had fewer than 2 runs. Scoring a batch
 *     again appends a new row; the newest computed_at is the current one.
 *
 *   - deployment_fingerprints follows the section 7 sketch (hash, model_name,
 *     model_version, system_prompt_hash, tool_schema_hash, first_seen_at) plus the
 *     components themselves: system_prompt (the text, nullable like its hash) and
 *     tool_schema_json (the canonical tool list). A hash alone says a deploy changed; the
 *     components say what changed, which is the question anyone looking at a regression
 *     asks next. Rows are content-addressed and never updated. runs.deployment_fingerprint
 *     holds the hash; it carries no foreign key because SQLite cannot add one to an
 *     existing column, and runs created before fingerprinting keep null (unknown), which
 *     is the truth about them. See src/fingerprint.ts for how the hash is computed.
 *
 *   - adversarial mode (ARCHITECTURE.md section 4, "injection propagation"): batches.kind
 *     separates an adversarial batch from a consistency batch, so the two never mix in a
 *     leaderboard, a trend or a gate. batches.payload_id and batches.adversarial_payload
 *     (JSON snapshot of the payload fixture as it was run) say what was planted.
 *     tool_calls.is_injected / injection_payload_id mark the one call whose response the
 *     proxy modified, so a trace shows exactly where the planted text entered.
 */
export const SCHEMA_SQL = `
create table if not exists tasks (
  id                  text primary key,
  name                text unique not null,
  prompt_template     text not null,
  success_rubric      text not null,
  forbidden_mutations text not null default '[]',
  dangerous_tools     text not null default '[]',
  volatile_fields     text not null default '[]',
  thresholds          text not null,
  owner               text,
  created_at          text not null
);

create table if not exists variants (
  id              text primary key,
  task_id         text not null references tasks(id),
  label           text not null,
  phrasing_text   text not null,
  fixture_version integer not null,
  approved_by     text,
  generated_at    text,
  unique (task_id, fixture_version, label)
);

create table if not exists batches (
  id                 text primary key,
  task_id            text not null references tasks(id),
  tier               text not null check (tier in ('smoke','full')),
  trials_per_variant integer not null,
  variants_requested integer not null,
  variant_labels     text not null,
  created_at         text not null,
  finished_at        text,
  kind               text not null default 'consistency' check (kind in ('consistency','adversarial')),
  payload_id         text,
  adversarial_payload text
);

create table if not exists runs (
  id                     text primary key,
  task_id                text not null references tasks(id),
  variant_id             text not null references variants(id),
  batch_id               text references batches(id),
  trial_number           integer not null,
  attempt                integer not null default 1,
  superseded             integer not null default 0,
  deployment_fingerprint text,
  status                 text not null check (status in ('running','ok','timeout','infra_error')),
  final_output           text,
  latency_ms             integer,
  token_cost             real,
  trace_blob_ref         text,
  created_at             text not null
);

create table if not exists tool_calls (
  id             text primary key,
  run_id         text not null references runs(id),
  sequence_index integer not null,
  tool_name      text not null,
  args_json      text,
  response_json  text,
  is_sandboxed   integer not null default 0,
  called_at      text not null,
  is_injected    integer not null default 0,
  injection_payload_id text,
  unique (run_id, sequence_index)
);

create table if not exists scores (
  id                         text primary key,
  task_id                    text not null references tasks(id),
  evaluation_batch_id        text not null references batches(id),
  outcome_consistency        real,
  tool_path_consistency      real,
  state_mutation_consistency real,
  injection_propagated       integer,
  runs_scored                integer not null,
  details                    text not null default '{}',
  computed_at                text not null
);

create table if not exists deployment_fingerprints (
  hash               text primary key,
  model_name         text not null,
  model_version      text not null,
  system_prompt_hash text,
  tool_schema_hash   text not null,
  system_prompt      text,
  tool_schema_json   text not null,
  first_seen_at      text not null
);

create index if not exists scores_batch_idx on scores (evaluation_batch_id, computed_at);
create index if not exists tool_calls_run_idx on tool_calls (run_id, sequence_index);
create index if not exists runs_task_idx on runs (task_id, variant_id, trial_number);
`;

/**
 * Columns added to runs after the first schema shipped. `create table if not exists`
 * leaves an existing trace.db untouched, so these are applied with ALTER TABLE when
 * missing. Each one is nullable or defaulted, so existing rows stay valid: a pre-batch
 * run reads as batch_id null, attempt 1, not superseded, which is exactly what it was.
 */
export const RUNS_MIGRATIONS: Array<{ column: string; ddl: string }> = [
  { column: "batch_id", ddl: "alter table runs add column batch_id text references batches(id)" },
  { column: "attempt", ddl: "alter table runs add column attempt integer not null default 1" },
  { column: "superseded", ddl: "alter table runs add column superseded integer not null default 0" },
];

/**
 * Adversarial-mode columns, added the same way for stores created before adversarial
 * mode. Defaults describe old rows truthfully: every earlier batch was a consistency
 * batch, and no earlier tool call was injected.
 */
export const TABLE_MIGRATIONS: Array<{ table: string; column: string; ddl: string }> = [
  {
    table: "batches",
    column: "kind",
    ddl: "alter table batches add column kind text not null default 'consistency' check (kind in ('consistency','adversarial'))",
  },
  { table: "batches", column: "payload_id", ddl: "alter table batches add column payload_id text" },
  { table: "batches", column: "adversarial_payload", ddl: "alter table batches add column adversarial_payload text" },
  { table: "tool_calls", column: "is_injected", ddl: "alter table tool_calls add column is_injected integer not null default 0" },
  { table: "tool_calls", column: "injection_payload_id", ddl: "alter table tool_calls add column injection_payload_id text" },
];

/** Indexes over migrated columns; created only after the migrations have run. */
export const POST_MIGRATION_SQL = `
create index if not exists runs_batch_idx on runs (batch_id, superseded);
create index if not exists runs_fingerprint_idx on runs (deployment_fingerprint);
create index if not exists batches_kind_idx on batches (task_id, kind, created_at);
`;

/** Every table a current trace.db has; a read-only open checks for them instead of migrating. */
export const REQUIRED_TABLES = ["tasks", "variants", "batches", "runs", "tool_calls", "scores", "deployment_fingerprints"];
