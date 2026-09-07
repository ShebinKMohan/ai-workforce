/**
 * Schema v1 for the coordinator state store (plan section 8 core records).
 *
 * Large logs and patches live in the artifact store; the database holds
 * references and hashes. JSON columns are validated on read at the boundary
 * that consumes them.
 */
import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  readonly version: number;
  readonly description: string;
  up(db: DatabaseSync): void;
}

const V1_STATEMENTS: ReadonlyArray<string> = [
  `CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    canonical_path TEXT NOT NULL UNIQUE,
    repo_identity TEXT NOT NULL,
    base_mode TEXT NOT NULL DEFAULT 'head',
    instructions_json TEXT NOT NULL DEFAULT '{}',
    checks_json TEXT NOT NULL DEFAULT '[]',
    data_location TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE runtimes (
    id TEXT PRIMARY KEY,
    adapter TEXT NOT NULL,
    executable TEXT NOT NULL,
    version TEXT,
    capabilities_json TEXT NOT NULL DEFAULT '{}',
    readiness_json TEXT NOT NULL DEFAULT '{}',
    observed_at TEXT NOT NULL
  )`,
  `CREATE TABLE agent_snapshots (
    hash TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    binding_version INTEGER NOT NULL,
    canonical_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id),
    request_json TEXT NOT NULL,
    repo_path TEXT NOT NULL,
    base_revision TEXT,
    contract_version INTEGER NOT NULL DEFAULT 1,
    policy TEXT NOT NULL,
    limits_json TEXT NOT NULL,
    state TEXT NOT NULL,
    ownership_epoch INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    ended_at TEXT
  )`,
  `CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    parent_task_id TEXT REFERENCES tasks(id),
    objective TEXT NOT NULL,
    contract_json TEXT NOT NULL,
    contract_version INTEGER NOT NULL,
    context_refs_json TEXT NOT NULL DEFAULT '[]',
    owner_agent_id TEXT,
    state TEXT NOT NULL,
    wait_reason TEXT,
    current_generation INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX tasks_run_idx ON tasks(run_id, state)`,
  `CREATE TABLE dependencies (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    consumer_task_id TEXT NOT NULL REFERENCES tasks(id),
    producer_task_id TEXT REFERENCES tasks(id),
    required_kind TEXT NOT NULL,
    required_ref TEXT,
    required_version INTEGER,
    satisfied_at TEXT,
    evidence_json TEXT
  )`,
  `CREATE INDEX dependencies_consumer_idx ON dependencies(consumer_task_id)`,
  `CREATE TABLE attempts (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    run_id TEXT NOT NULL REFERENCES runs(id),
    generation INTEGER NOT NULL,
    agent_snapshot_hash TEXT NOT NULL REFERENCES agent_snapshots(hash),
    runtime_id TEXT,
    runtime_version TEXT,
    process_id INTEGER,
    session_id TEXT,
    turn_id TEXT,
    workspace_path TEXT,
    state TEXT NOT NULL,
    outcome_json TEXT,
    interrupted INTEGER NOT NULL DEFAULT 0,
    uncertain_outcome INTEGER NOT NULL DEFAULT 0,
    superseded_by TEXT REFERENCES attempts(id),
    started_at TEXT,
    ended_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(task_id, generation)
  )`,
  `CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    sender_task_id TEXT REFERENCES tasks(id),
    sender_attempt_id TEXT REFERENCES attempts(id),
    recipient_task_id TEXT REFERENCES tasks(id),
    correlation_id TEXT,
    idempotency_key TEXT NOT NULL,
    type TEXT NOT NULL,
    body_json TEXT NOT NULL,
    contract_version INTEGER NOT NULL,
    delivery_state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    submitted_at TEXT,
    acknowledged_at TEXT,
    UNIQUE(run_id, idempotency_key)
  )`,
  `CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    task_id TEXT REFERENCES tasks(id),
    attempt_id TEXT REFERENCES attempts(id),
    type TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    base_revision TEXT,
    candidate_revision TEXT,
    provenance_json TEXT NOT NULL,
    retention TEXT NOT NULL DEFAULT 'keep',
    created_at TEXT NOT NULL,
    UNIQUE(run_id, relative_path)
  )`,
  `CREATE TABLE checks (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    task_id TEXT REFERENCES tasks(id),
    attempt_id TEXT REFERENCES attempts(id),
    criterion_ids_json TEXT NOT NULL,
    command TEXT NOT NULL,
    args_json TEXT NOT NULL,
    cwd TEXT NOT NULL,
    env_identity TEXT NOT NULL,
    candidate_hash TEXT,
    candidate_revision TEXT,
    outcome TEXT NOT NULL,
    exit_code INTEGER,
    log_artifact_id TEXT REFERENCES artifacts(id),
    evidence_provenance TEXT NOT NULL,
    started_at TEXT,
    ended_at TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE operations (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    task_id TEXT REFERENCES tasks(id),
    attempt_id TEXT REFERENCES attempts(id),
    kind TEXT NOT NULL,
    generation INTEGER NOT NULL,
    intent_json TEXT NOT NULL,
    state TEXT NOT NULL,
    receipt_json TEXT,
    uncertain_outcome INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    dispatched_at TEXT,
    completed_at TEXT
  )`,
  `CREATE INDEX operations_run_state_idx ON operations(run_id, state)`,
  `CREATE TABLE events (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    sequence INTEGER NOT NULL,
    task_id TEXT,
    attempt_id TEXT,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    payload_ref TEXT,
    idempotency_key TEXT,
    timestamp TEXT NOT NULL,
    UNIQUE(run_id, sequence),
    UNIQUE(run_id, idempotency_key)
  )`,
];

export const MIGRATIONS: ReadonlyArray<Migration> = [
  {
    version: 1,
    description: 'initial schema: projects, runtimes, agent_snapshots, runs, tasks, dependencies, attempts, messages, artifacts, checks, operations, events',
    up(db) {
      for (const statement of V1_STATEMENTS) db.exec(statement);
    },
  },
];

export const SUPPORTED_SCHEMA_VERSION: number = MIGRATIONS[MIGRATIONS.length - 1]!.version;
