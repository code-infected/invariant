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
 * The scores and deployment_fingerprints tables from section 7 are intentionally absent:
 * nothing computes scores or fingerprints yet, and creating empty tables ahead of the
 * code that fills them just invites them to drift from whatever that code ends up needing.
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

create table if not exists runs (
  id                     text primary key,
  task_id                text not null references tasks(id),
  variant_id             text not null references variants(id),
  trial_number           integer not null,
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
  unique (run_id, sequence_index)
);

create index if not exists tool_calls_run_idx on tool_calls (run_id, sequence_index);
create index if not exists runs_task_idx on runs (task_id, variant_id, trial_number);
`;
