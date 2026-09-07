/**
 * Artifact store (plan section 8: publish bytes atomically and durably,
 * verify the hash, then record the receipt in a database transaction).
 *
 * Write path: temp file in the run's artifacts directory -> fsync -> rename
 * onto the final path -> fsync directory -> INSERT receipt. A crash before
 * the INSERT leaves an orphan file that reconciliation may clean up; a
 * receipt never exists without its bytes. Reads re-hash the bytes and fail
 * loudly on missing or corrupted content, which invalidates dependent
 * acceptance.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { newId, nowIso, randomToken } from '../core/ids.js';
import { sha256Hex } from '../core/snapshot.js';
import { ensureRunDir, isWithin, type StatePaths } from './paths.js';
import { withTransaction } from './tx.js';

export type ArtifactRetention = 'keep' | 'eligible_for_cleanup';

export interface ArtifactRecord {
  readonly id: string;
  readonly runId: string;
  readonly taskId: string | null;
  readonly attemptId: string | null;
  readonly type: string;
  /** Relative to the run's artifacts directory; exports never need absolute paths. */
  readonly relativePath: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly baseRevision: string | null;
  readonly candidateRevision: string | null;
  readonly provenance: Record<string, unknown>;
  readonly retention: ArtifactRetention;
  readonly createdAt: string;
}

interface ArtifactRow {
  id: string;
  run_id: string;
  task_id: string | null;
  attempt_id: string | null;
  type: string;
  relative_path: string;
  sha256: string;
  size_bytes: number;
  base_revision: string | null;
  candidate_revision: string | null;
  provenance_json: string;
  retention: ArtifactRetention;
  created_at: string;
}

function toRecord(row: ArtifactRow): ArtifactRecord {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    type: row.type,
    relativePath: row.relative_path,
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
    baseRevision: row.base_revision,
    candidateRevision: row.candidate_revision,
    provenance: JSON.parse(row.provenance_json) as Record<string, unknown>,
    retention: row.retention,
    createdAt: row.created_at,
  };
}

export class ArtifactError extends Error {
  readonly artifactId: string | null;

  constructor(name: string, artifactId: string | null, message: string) {
    super(message);
    this.name = name;
    this.artifactId = artifactId;
  }
}

export class ArtifactMissingError extends ArtifactError {
  constructor(artifactId: string, filePath: string) {
    super('ArtifactMissingError', artifactId, `artifact ${artifactId} is recorded but its bytes are missing at ${filePath}; dependent acceptance is invalid`);
  }
}

export class ArtifactCorruptError extends ArtifactError {
  constructor(artifactId: string, expected: string, actual: string) {
    super('ArtifactCorruptError', artifactId, `artifact ${artifactId} content hash ${actual} does not match recorded ${expected}; dependent acceptance is invalid`);
  }
}

export class ArtifactExistsError extends ArtifactError {
  constructor(runId: string, relativePath: string) {
    super('ArtifactExistsError', null, `artifact "${relativePath}" already exists for run ${runId}; artifacts are immutable, publish under a new path`);
  }
}

export interface WriteArtifactInput {
  readonly runId: string;
  readonly taskId?: string | null;
  readonly attemptId?: string | null;
  readonly type: string;
  readonly relativePath: string;
  readonly bytes: Uint8Array | string;
  readonly baseRevision?: string | null;
  readonly candidateRevision?: string | null;
  readonly provenance: Record<string, unknown>;
  readonly retention?: ArtifactRetention;
  readonly now?: string;
}

function resolveArtifactPath(paths: StatePaths, runId: string, relativePath: string): string {
  const root = paths.runArtifactsDir(runId);
  if (path.isAbsolute(relativePath) || relativePath.length === 0) {
    throw new ArtifactError('ArtifactPathError', null, `artifact path must be relative and non-empty, got "${relativePath}"`);
  }
  const full = path.resolve(root, relativePath);
  if (!isWithin(root, full) || full === root) {
    throw new ArtifactError('ArtifactPathError', null, `artifact path "${relativePath}" escapes the run artifacts directory`);
  }
  return full;
}

function fsyncDirectory(dir: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    // Directory fsync is best effort on some filesystems; the file itself was fsynced.
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Publish bytes atomically, verify, then record the receipt in a transaction. */
export function writeArtifact(db: DatabaseSync, paths: StatePaths, input: WriteArtifactInput): ArtifactRecord {
  const bytes = typeof input.bytes === 'string' ? Buffer.from(input.bytes, 'utf8') : Buffer.from(input.bytes);
  const existing = db.prepare('SELECT id FROM artifacts WHERE run_id = ? AND relative_path = ?').get(input.runId, input.relativePath) as { id: string } | undefined;
  if (existing !== undefined) throw new ArtifactExistsError(input.runId, input.relativePath);

  ensureRunDir(paths, input.runId);
  const finalPath = resolveArtifactPath(paths, input.runId, input.relativePath);
  const dir = path.dirname(finalPath);
  mkdirSync(dir, { recursive: true });
  const tempPath = path.join(dir, `.tmp-${randomToken(8)}`);
  const hash = sha256Hex(bytes);

  const fd = openSync(tempPath, 'wx', 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    try {
      unlinkSync(tempPath);
    } catch {
      // best effort cleanup
    }
    throw error;
  }
  closeSync(fd);

  // Verify what actually reached the disk before publishing it.
  if (sha256Hex(readFileSync(tempPath)) !== hash) {
    unlinkSync(tempPath);
    throw new ArtifactError('ArtifactWriteError', null, `artifact "${input.relativePath}" bytes on disk did not match the intended content`);
  }
  renameSync(tempPath, finalPath);
  fsyncDirectory(dir);

  const id = newId();
  const now = input.now ?? nowIso();
  try {
    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO artifacts(id, run_id, task_id, attempt_id, type, relative_path, sha256, size_bytes, base_revision, candidate_revision, provenance_json, retention, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.runId,
        input.taskId ?? null,
        input.attemptId ?? null,
        input.type,
        input.relativePath,
        hash,
        bytes.length,
        input.baseRevision ?? null,
        input.candidateRevision ?? null,
        JSON.stringify(input.provenance),
        input.retention ?? 'keep',
        now,
      );
    });
  } catch (error) {
    // The bytes exist but the receipt failed: leave the file for orphan reconciliation and surface the error.
    throw new ArtifactError('ArtifactReceiptError', null, `artifact "${input.relativePath}" was published but its receipt could not be recorded: ${(error as Error).message}`);
  }
  return getArtifact(db, id);
}

export function getArtifact(db: DatabaseSync, id: string): ArtifactRecord {
  const row = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as ArtifactRow | undefined;
  if (row === undefined) throw new ArtifactError('ArtifactNotFoundError', id, `artifact ${id} is not recorded`);
  return toRecord(row);
}

export function listArtifacts(db: DatabaseSync, runId: string): ArtifactRecord[] {
  return (db.prepare('SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at, id').all(runId) as unknown as ArtifactRow[]).map(toRecord);
}

export function artifactAbsolutePath(paths: StatePaths, record: ArtifactRecord): string {
  return resolveArtifactPath(paths, record.runId, record.relativePath);
}

export interface ArtifactVerification {
  readonly ok: boolean;
  readonly reason: 'ok' | 'missing' | 'corrupt';
  readonly record: ArtifactRecord;
  readonly actualSha256: string | null;
}

/** Re-hash the stored bytes and compare with the receipt. Never throws for missing/corrupt content. */
export function verifyArtifact(db: DatabaseSync, paths: StatePaths, id: string): ArtifactVerification {
  const record = getArtifact(db, id);
  const filePath = artifactAbsolutePath(paths, record);
  let bytes: Buffer;
  try {
    statSync(filePath);
    bytes = readFileSync(filePath);
  } catch {
    return { ok: false, reason: 'missing', record, actualSha256: null };
  }
  const actual = sha256Hex(bytes);
  if (actual !== record.sha256 || bytes.length !== record.sizeBytes) return { ok: false, reason: 'corrupt', record, actualSha256: actual };
  return { ok: true, reason: 'ok', record, actualSha256: actual };
}

/** Read and verify artifact bytes. Throws ArtifactMissingError or ArtifactCorruptError. */
export function readArtifact(db: DatabaseSync, paths: StatePaths, id: string): { record: ArtifactRecord; bytes: Buffer } {
  const record = getArtifact(db, id);
  const filePath = artifactAbsolutePath(paths, record);
  let bytes: Buffer;
  try {
    bytes = readFileSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ArtifactMissingError(id, filePath);
    throw error;
  }
  const actual = sha256Hex(bytes);
  if (actual !== record.sha256 || bytes.length !== record.sizeBytes) throw new ArtifactCorruptError(id, record.sha256, actual);
  return { record, bytes };
}
