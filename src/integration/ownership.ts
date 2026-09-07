/**
 * Exclusive writer ownership per task workspace (FR043) and per-attempt
 * resource allocation (FR044).
 *
 * The rule this module exists to enforce: at most one attempt may be writing a
 * given task workspace, and a replacement attempt cannot take that workspace
 * until the previous writer is *observed* stopped or *provably* denied access.
 *
 * A row in a database saying "attempt B owns this now" is not that observation.
 * A worker process that reported a result still holds its file descriptors and
 * its write permissions; nothing about persisting a new owner takes those away.
 * So a claim over a contended workspace is granted only when one of these is
 * true:
 *
 *   - the incumbent's recorded process identity probes as `dead` or
 *     `pid_reused` (the process we recorded is provably gone), or
 *   - the caller recorded a stop with evidence: an observed exit/signal, or an
 *     enforcement point that denied the writer access, or
 *   - the caller asks for an *isolated successor* instead, which allocates a
 *     brand new workspace key and its own resources and leaves the contended
 *     workspace to its incumbent.
 *
 * `unverifiable` liveness (the pid exists but cannot be matched to the writer
 * we recorded) is treated as contention, never as a stop.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { nowIso, randomToken } from '../core/ids.js';
import { matchProcessIdentity, type ProcessIdentity, type ProcessIdentityStatus } from '../core/process.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WriterState = 'claimed' | 'writing' | 'stopped' | 'denied';

/** Why a writer is no longer holding the workspace. Only these end a claim. */
export type StopEvidence =
  | { readonly kind: 'observed_exit'; readonly exitCode: number | null; readonly signal?: string | null; readonly detail?: string }
  | { readonly kind: 'observed_process_gone'; readonly probe: ProcessIdentityStatus; readonly detail?: string }
  | { readonly kind: 'access_denied'; readonly enforcedBy: string; readonly detail?: string };

/** Resources allocated to one attempt, unique to it while the claim is held (FR044). */
export interface AttemptResources {
  /** Private scratch directory. Created empty, removed on release. */
  readonly tempDir: string;
  /** Ports reserved for this attempt; never handed to another live attempt. */
  readonly ports: ReadonlyArray<number>;
}

export interface WriterClaim {
  readonly ownerToken: string;
  readonly workspaceKey: string;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly state: WriterState;
  /** Recorded once the writing process exists; null while nothing has been spawned. */
  readonly identity: ProcessIdentity | null;
  readonly resources: AttemptResources;
  readonly claimedAt: string;
  readonly endedAt: string | null;
  readonly endEvidence: StopEvidence | null;
  /** Set when this claim was created as an isolated successor to a contended one. */
  readonly isolatedFrom: string | null;
}

export type OwnershipErrorCode =
  | 'writer_live'
  | 'writer_unverifiable'
  | 'writer_unattached'
  | 'unknown_claim'
  | 'not_current_writer'
  | 'claim_already_ended'
  | 'port_allocation_failed';

export class OwnershipError extends Error {
  readonly code: OwnershipErrorCode;
  readonly workspaceKey: string;
  readonly incumbent: WriterClaim | null;
  /** Concrete ways out, in the order a caller should consider them. */
  readonly remedies: ReadonlyArray<string>;

  constructor(code: OwnershipErrorCode, workspaceKey: string, message: string, incumbent: WriterClaim | null = null, remedies: ReadonlyArray<string> = []) {
    super(message);
    this.name = 'OwnershipError';
    this.code = code;
    this.workspaceKey = workspaceKey;
    this.incumbent = incumbent;
    this.remedies = remedies;
  }
}

export interface ClaimInput {
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  /** How many unique ports this attempt needs. Defaults to none. */
  readonly ports?: number;
  /** Overrides the derived `<runId>/<taskId>` key; used by isolated successors. */
  readonly workspaceKey?: string;
}

export interface IsolatedSuccessorResult {
  readonly claim: WriterClaim;
  /** The workspace the successor deliberately did NOT take. */
  readonly contendedWorkspaceKey: string;
  readonly incumbent: WriterClaim;
  readonly reason: string;
}

export interface OwnershipOptions {
  /** Root under which per-attempt temp directories are created. */
  readonly resourceRoot: string;
  /** Liveness probe; injectable so tests do not need real processes. */
  readonly probe?: (identity: Pick<ProcessIdentity, 'pid' | 'startedAtMs'>) => ProcessIdentityStatus;
  /** Port source; injectable so tests are deterministic. */
  readonly allocatePort?: () => Promise<number>;
  readonly now?: () => string;
}

/** The canonical workspace key for a task: one writer per task workspace. */
export function taskWorkspaceKey(runId: string, taskId: string): string {
  return `${runId}/${taskId}`;
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 64) || 'x';
}

/** Ask the OS for a free loopback port. */
export async function allocateEphemeralPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ port: 0, host: '127.0.0.1' }, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('the operating system did not report a port for the probe socket')));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

// ---------------------------------------------------------------------------
// Ownership registry
// ---------------------------------------------------------------------------

export class WorkspaceOwnership {
  readonly #resourceRoot: string;
  readonly #probe: (identity: Pick<ProcessIdentity, 'pid' | 'startedAtMs'>) => ProcessIdentityStatus;
  readonly #allocatePort: () => Promise<number>;
  readonly #now: () => string;
  readonly #claims = new Map<string, WriterClaim>();
  readonly #currentByWorkspace = new Map<string, string>();
  readonly #reservedPorts = new Set<number>();
  #successorCounter = 0;

  constructor(options: OwnershipOptions) {
    this.#resourceRoot = path.resolve(options.resourceRoot);
    this.#probe = options.probe ?? ((identity) => matchProcessIdentity(identity));
    this.#allocatePort = options.allocatePort ?? allocateEphemeralPort;
    this.#now = options.now ?? nowIso;
    mkdirSync(this.#resourceRoot, { recursive: true, mode: 0o700 });
  }

  /** The claim currently holding a workspace, whatever its state. */
  current(workspaceKey: string): WriterClaim | null {
    const token = this.#currentByWorkspace.get(workspaceKey);
    return token === undefined ? null : (this.#claims.get(token) ?? null);
  }

  get(ownerToken: string): WriterClaim | null {
    return this.#claims.get(ownerToken) ?? null;
  }

  /** Every claim ever recorded, oldest first. Ended claims are kept as history. */
  history(workspaceKey?: string): ReadonlyArray<WriterClaim> {
    const all = [...this.#claims.values()];
    return workspaceKey === undefined ? all : all.filter((claim) => claim.workspaceKey === workspaceKey);
  }

  /**
   * Liveness of the workspace's current writer. `none` when nothing holds it.
   * A `stopped`/`denied` claim reports `released` without probing.
   */
  probeCurrent(workspaceKey: string): 'none' | 'released' | 'unattached' | ProcessIdentityStatus {
    const claim = this.current(workspaceKey);
    if (claim === null) return 'none';
    if (claim.state === 'stopped' || claim.state === 'denied') return 'released';
    if (claim.identity === null) return 'unattached';
    return this.#probe(claim.identity);
  }

  /**
   * Take exclusive write ownership of a task workspace.
   *
   * Refuses while an incumbent is live, unverifiable, or has no observed stop.
   * Refusal carries the incumbent and the remedies, so the caller can stop the
   * writer, record a denial, or take an isolated successor instead.
   */
  async claim(input: ClaimInput): Promise<WriterClaim> {
    const workspaceKey = input.workspaceKey ?? taskWorkspaceKey(input.runId, input.taskId);
    const incumbent = this.current(workspaceKey);
    if (incumbent !== null && incumbent.state !== 'stopped' && incumbent.state !== 'denied') {
      const status = incumbent.identity === null ? 'unattached' : this.#probe(incumbent.identity);
      if (status === 'unattached') {
        throw new OwnershipError(
          'writer_unattached',
          workspaceKey,
          `attempt "${incumbent.attemptId}" holds ${workspaceKey} and no writing process was ever recorded for it, so its stop cannot be observed; ownership in a record is not the same as a writer that has actually stopped`,
          incumbent,
          [
            `record the stop for owner ${incumbent.ownerToken} with the evidence that ended it (recordStop)`,
            'or take an isolated successor workspace instead (claimIsolatedSuccessor)',
          ],
        );
      }
      if (status === 'alive') {
        throw new OwnershipError(
          'writer_live',
          workspaceKey,
          `attempt "${incumbent.attemptId}" is still writing ${workspaceKey} (pid ${incumbent.identity?.pid ?? 'unknown'}, spawn ${incumbent.identity?.spawnToken ?? 'unknown'}); a replacement cannot take the workspace until that writer is stopped or denied access`,
          incumbent,
          [
            'stop the writing process and record the observed exit (recordStop)',
            'or deny it access at the enforcement point and record the denial (recordStop)',
            'or take an isolated successor workspace instead (claimIsolatedSuccessor)',
          ],
        );
      }
      if (status === 'unverifiable') {
        throw new OwnershipError(
          'writer_unverifiable',
          workspaceKey,
          `pid ${incumbent.identity?.pid ?? 'unknown'} for attempt "${incumbent.attemptId}" exists but cannot be verified as the writer of ${workspaceKey}; uncertain liveness is contention, not a stop`,
          incumbent,
          ['take an isolated successor workspace instead (claimIsolatedSuccessor)', 'or deny the writer access at the enforcement point and record the denial (recordStop)'],
        );
      }
      // dead | pid_reused: the recorded writer is provably gone. That is an
      // observation, so the incumbent is retired here rather than overwritten.
      this.#endClaim(incumbent.ownerToken, 'stopped', { kind: 'observed_process_gone', probe: status, detail: `probed on takeover by attempt "${input.attemptId}"` });
    }

    const resources = await this.#allocateResources(workspaceKey, input.attemptId, input.ports ?? 0);
    const claim: WriterClaim = {
      ownerToken: `own-${randomToken(8)}`,
      workspaceKey,
      runId: input.runId,
      taskId: input.taskId,
      attemptId: input.attemptId,
      state: 'claimed',
      identity: null,
      resources,
      claimedAt: this.#now(),
      endedAt: null,
      endEvidence: null,
      isolatedFrom: null,
    };
    this.#claims.set(claim.ownerToken, claim);
    this.#currentByWorkspace.set(workspaceKey, claim.ownerToken);
    return claim;
  }

  /**
   * Allocate a *separate* workspace for a replacement attempt while the
   * contended one keeps its incumbent. This is the safe alternative to taking a
   * workspace whose writer cannot be proven stopped.
   */
  async claimIsolatedSuccessor(input: ClaimInput): Promise<IsolatedSuccessorResult> {
    const contendedWorkspaceKey = input.workspaceKey ?? taskWorkspaceKey(input.runId, input.taskId);
    const incumbent = this.current(contendedWorkspaceKey);
    if (incumbent === null) {
      throw new OwnershipError('unknown_claim', contendedWorkspaceKey, `${contendedWorkspaceKey} has no current writer, so there is nothing to succeed; claim it directly`);
    }
    this.#successorCounter += 1;
    const successorKey = `${contendedWorkspaceKey}~succ${this.#successorCounter}`;
    const status = incumbent.identity === null ? 'unattached' : this.#probe(incumbent.identity);
    const claim = await this.claim({ ...input, workspaceKey: successorKey });
    const isolated: WriterClaim = { ...claim, isolatedFrom: incumbent.ownerToken };
    this.#claims.set(isolated.ownerToken, isolated);
    return {
      claim: isolated,
      contendedWorkspaceKey,
      incumbent,
      reason: `attempt "${incumbent.attemptId}" still holds ${contendedWorkspaceKey} (${status}); the successor was given ${successorKey} and its own resources instead of taking a workspace with an unstopped writer`,
    };
  }

  /** Record the writing process. Call immediately after spawn. */
  attachWriter(ownerToken: string, identity: ProcessIdentity): WriterClaim {
    const claim = this.#requireOpen(ownerToken);
    const updated: WriterClaim = { ...claim, identity, state: 'writing' };
    this.#claims.set(ownerToken, updated);
    return updated;
  }

  /**
   * End a claim with the evidence that ended it. This is the only way a
   * workspace becomes available to a replacement other than a probe that proves
   * the recorded process is gone.
   */
  recordStop(ownerToken: string, evidence: StopEvidence): WriterClaim {
    const claim = this.#requireOpen(ownerToken);
    const state: WriterState = evidence.kind === 'access_denied' ? 'denied' : 'stopped';
    return this.#endClaim(claim.ownerToken, state, evidence);
  }

  /** True when this token may write its workspace right now. */
  isCurrentWriter(ownerToken: string): boolean {
    const claim = this.#claims.get(ownerToken);
    if (claim === undefined || claim.state === 'stopped' || claim.state === 'denied') return false;
    return this.#currentByWorkspace.get(claim.workspaceKey) === ownerToken;
  }

  /** Throw unless this token is the workspace's current writer. */
  assertCurrentWriter(ownerToken: string): WriterClaim {
    const claim = this.#claims.get(ownerToken);
    if (claim === undefined) throw new OwnershipError('unknown_claim', '(unknown)', `owner token "${ownerToken}" is not a claim this registry issued`);
    if (!this.isCurrentWriter(ownerToken)) {
      throw new OwnershipError(
        'not_current_writer',
        claim.workspaceKey,
        `owner token "${ownerToken}" (attempt "${claim.attemptId}") is no longer the writer of ${claim.workspaceKey}; state is "${claim.state}"`,
        this.current(claim.workspaceKey),
      );
    }
    return claim;
  }

  /** Free the attempt's resources. Ports return to the pool; the temp dir is removed. */
  releaseResources(ownerToken: string, options: { readonly removeTempDir?: boolean } = {}): void {
    const claim = this.#claims.get(ownerToken);
    if (claim === undefined) return;
    for (const port of claim.resources.ports) this.#reservedPorts.delete(port);
    if (options.removeTempDir !== false) rmSync(claim.resources.tempDir, { recursive: true, force: true });
  }

  async #allocateResources(workspaceKey: string, attemptId: string, ports: number): Promise<AttemptResources> {
    const dir = path.join(this.#resourceRoot, safeSegment(workspaceKey.replace(/\//g, '-')));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tempDir = mkdtempSync(path.join(dir, `${safeSegment(attemptId)}-`));
    const reserved: number[] = [];
    for (let i = 0; i < ports; i += 1) {
      let port: number | null = null;
      for (let tries = 0; tries < 40 && port === null; tries += 1) {
        const candidate = await this.#allocatePort();
        if (!this.#reservedPorts.has(candidate)) port = candidate;
      }
      if (port === null) {
        for (const taken of reserved) this.#reservedPorts.delete(taken);
        rmSync(tempDir, { recursive: true, force: true });
        throw new OwnershipError('port_allocation_failed', workspaceKey, `could not allocate ${ports} unique port(s) for attempt "${attemptId}": every probed port was already reserved by a live attempt`);
      }
      this.#reservedPorts.add(port);
      reserved.push(port);
    }
    return { tempDir, ports: reserved };
  }

  #requireOpen(ownerToken: string): WriterClaim {
    const claim = this.#claims.get(ownerToken);
    if (claim === undefined) throw new OwnershipError('unknown_claim', '(unknown)', `owner token "${ownerToken}" is not a claim this registry issued`);
    if (claim.state === 'stopped' || claim.state === 'denied') {
      throw new OwnershipError('claim_already_ended', claim.workspaceKey, `the claim for attempt "${claim.attemptId}" on ${claim.workspaceKey} already ended as "${claim.state}"`, claim);
    }
    return claim;
  }

  #endClaim(ownerToken: string, state: 'stopped' | 'denied', evidence: StopEvidence): WriterClaim {
    const claim = this.#claims.get(ownerToken);
    if (claim === undefined) throw new OwnershipError('unknown_claim', '(unknown)', `owner token "${ownerToken}" is not a claim this registry issued`);
    const ended: WriterClaim = { ...claim, state, endedAt: this.#now(), endEvidence: evidence };
    this.#claims.set(ownerToken, ended);
    return ended;
  }
}
