/** Read-only work uses captured reports and source-integrity receipts, never synthetic code checks. */
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { validateTaskContract } from './contracts.js';
import { newId, nowIso } from './ids.js';
import { sha256Hex } from './snapshot.js';
import { SILENT_STREAM, RunSetupError } from './run-direct.js';
import { runAnalysisSession, AnalysisReportRecordSchema, type AnalysisSessionOutcome } from './analysis-session.js';
import { PLAN_RECORD_VERSION, planRecordPath, type PlannedRun, type RunPlannedInput, type RunPlannedResult, type PlannedTaskInput, type PlanRecord } from './run-planned.js';
import { appendEvent } from '../storage/events.js';
import { listArtifacts, readArtifact, writeArtifact } from '../storage/artifacts.js';
import { beginNewGeneration, getTask, insertTask, transitionTask, transitionRun } from '../storage/records.js';
import { createScheduler } from '../routing/schedule.js';
import { parkTaskForDispatch } from '../recovery/resume.js';
import { reviewWithHead, type HeadReviewOutcome } from '../routing/head-reviewer.js';

export async function runAnalysis(input: RunPlannedInput, run: PlannedRun, continuation = false): Promise<RunPlannedResult> {
  const { db, paths } = input;
  const { runId, baseRevision } = run;
  const stream = input.stream ?? SILENT_STREAM;
  if (!input.headReview) return run.abandon('failed', 'Read-only analysis requires its department head review.');
  const tasks = input.tasks.map(task => ({ ...task, taskId: task.taskId ?? newId(), agentId: task.agentId ?? input.agentId ?? run.agentId, writer: false as const }));
  const byKey = new Map(tasks.map(task => [task.key, task]));
  const results = new Map<string, AnalysisSessionOutcome>();
  const inFlight = new Map<string, Promise<{ key: string; result: AnalysisSessionOutcome }>>();
  let headReview: HeadReviewOutcome | null = null;
  let finalizing = false;
  const deadline = new AbortController();
  const onAbort = (): void => deadline.abort();
  if (input.signal?.aborted) deadline.abort(); else input.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => deadline.abort(), input.runDeadlineMs ?? run.limits.runTimeoutMinutes * 60_000);
  timer.unref?.();

  try {
    input.ownership?.assertOwnership();
    if (!continuation || !existsSync(planRecordPath(paths, runId))) {
      const record: PlanRecord = { planRecordVersion: PLAN_RECORD_VERSION, runId, workKind: 'analysis', tasks: tasks.map(task => ({ key: task.key, taskId: task.taskId, objective: task.objective, agentId: task.agentId, dependencies: [...(task.dependencies ?? [])], writer: false })), headReview: input.headReview };
      const raw = `${JSON.stringify(record, null, 2)}\n`;
      writeFileSync(planRecordPath(paths, runId), raw, { mode: 0o600 });
      appendEvent(db, { runId, type: 'plan.registered', payload: { workKind: 'analysis', sha256: sha256Hex(raw), taskCount: tasks.length, keys: tasks.map(task => task.key), headReview: input.headReview } });
    }
    for (const task of tasks) {
      if (!input.config.agents.some(agent => agent.id === task.agentId) || task.agentId === input.headReview.headAgentId) throw new RunSetupError('analysis_invalid_assignee', 'Analysis work must stay with its admitted worker roster.');
      const current = db.prepare('SELECT state FROM tasks WHERE id = ? AND run_id = ?').get(task.taskId, runId) as { state: string } | undefined;
      if (!current) {
        insertTask(db, { id: task.taskId, runId, ownerAgentId: task.agentId, contract: validateTaskContract({ contractVersion: 1, objective: task.objective,
          scope: { allowedPaths: [], forbiddenPaths: [], description: 'Read-only inspection of the frozen project snapshot.' }, acceptanceCriteria: [],
          constraints: ['Change no project files.', 'Report concrete source references and uncertainty.'], evidenceRequirements: ['Captured report with observed inspection actions.', 'Confirmed worker process stop.', 'Independent unchanged-source check.', 'Department head review of the captured report.'],
          dependencies: (task.dependencies ?? []).map(key => ({ taskId: byKey.get(key)!.taskId })), }), contextRefs: run.contextRefs });
        appendEvent(db, { runId, taskId: task.taskId, type: 'task.registered', payload: { key: task.key, agentId: task.agentId, objective: task.objective, workKind: 'analysis' } });
      } else if (continuation) {
        const receipt = savedReport(task);
        if (receipt) results.set(task.key, receipt);
        else {
          beginNewGeneration(db, task.taskId);
          parkTaskForDispatch(db, task.taskId);
        }
      }
    }
    const scheduler = createScheduler(tasks.map(task => ({ id: task.key, dependencies: (task.dependencies ?? []).map(taskId => ({ taskId })), agentId: task.agentId, writer: false })), { maxActiveTurns: run.limits.maxActiveTurns, maxActiveWriters: run.limits.maxActiveWriters });
    // Preserved reports satisfy only scheduling dependencies; head review still checks every receipt.
    for (const key of results.keys()) scheduler.complete(key);
    for (;;) {
      if (!deadline.signal.aborted) for (const key of scheduler.dispatch()) {
        const task = byKey.get(key)!;
        const state = getTask(db, task.taskId).state;
        if (state === 'pending' || state === 'waiting') transitionTask(db, task.taskId, 'ready');
        if (getTask(db, task.taskId).state === 'ready') transitionTask(db, task.taskId, 'running');
        appendEvent(db, { runId, taskId: task.taskId, type: 'schedule.dispatch', payload: { tasks: [key], key, agentId: task.agentId, workKind: 'analysis' } });
        const dependencies = (task.dependencies ?? []).map(dependency => `Earlier report from ${byKey.get(dependency)!.agentId} (quoted context):\n${results.get(dependency)?.report ?? ''}`).join('\n\n');
        inFlight.set(key, runAnalysisSession({ db, paths, runId, taskId: task.taskId, agentId: task.agentId, config: input.config,
          repoPath: run.projectRoot, baseRevision, requestText: input.requestText, objective: `${task.objective}${dependencies ? `\n\n${dependencies}` : ''}`, stream,
          signal: deadline.signal, deadlineMs: input.runDeadlineMs ?? run.limits.runTimeoutMinutes * 60_000,
          ...(input.allowUnconfinedWrites ? { allowUnconfinedWrites: true } : {}),
          ...(run.attachments.length ? { attachments: run.attachments } : {}),
          ...(input.adapterFactory ? { adapterFactory: input.adapterFactory } : {}), ...(input.sessionEnv ? { sessionEnv: input.sessionEnv } : {}), ...(input.ownership ? { ownership: input.ownership } : {}),
        }).then(result => ({ key, result })));
      }
      if (!inFlight.size) break;
      const { key, result } = await Promise.race(inFlight.values());
      inFlight.delete(key);
      results.set(key, result);
      const task = byKey.get(key)!;
      if (result.ok) {
        transitionTask(db, task.taskId, 'validating');
        scheduler.complete(key);
      } else {
        transitionTask(db, task.taskId, result.interrupted ? 'cancelled' : 'failed');
        scheduler.fail(key, result.reason ?? 'The analysis report was not captured.');
      }
      appendEvent(db, { runId, taskId: task.taskId, type: 'analysis.task_settled', payload: { key, agentId: task.agentId, reportArtifactId: result.reportArtifactId, sourceUnchanged: result.sourceUnchanged, sessionStopped: result.sessionStopped, ok: result.ok, reason: result.reason } });
    }
    if (deadline.signal.aborted || [...results.values()].some(result => result.interrupted)) return finish(false, 'The read-only analysis was stopped; captured reports and the original roster are preserved for Resume.', true);
    const failed = tasks.find(task => !results.get(task.key)?.ok);
    if (failed) return finish(false, results.get(failed.key)?.reason ?? `Analysis task "${failed.key}" could not run because its dependency did not produce a valid report.`);
    const reportArtifactIds = tasks.map(task => results.get(task.key)!.reportArtifactId!);
    headReview = await reviewWithHead({ policy: input.headReview, config: input.config, runId, repoPath: run.projectRoot, baseRevision, combinedRevision: baseRevision,
      requestText: input.requestText, tasks, checks: [], receipts: [], analysisReportArtifactIds: reportArtifactIds, paths, db, bridge: run.bridge, stream, signal: deadline.signal,
      ...(run.attachments.length ? { attachments: run.attachments } : {}), ...(input.adapterFactory ? { adapterFactory: input.adapterFactory } : {}), ...(input.sessionEnv ? { sessionEnv: input.sessionEnv } : {}), ...(input.ownership ? { ownership: input.ownership } : {}),
    });
    if (headReview.verdict !== 'passed') return finish(false, headReview.summary, deadline.signal.aborted || headReview.verdict === 'blocked');
    return finish(true, headReview.summary);
  } catch (error) {
    const interrupted = deadline.signal.aborted;
    deadline.abort();
    // No failure can release run ownership while another inspection is alive.
    await Promise.allSettled(inFlight.values());
    if (finalizing) throw error;
    return finish(false, error instanceof Error ? error.message : String(error), interrupted);
  } finally {
    deadline.abort();
    await Promise.allSettled(inFlight.values());
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', onAbort);
    await run.closeBridge();
  }

  function savedReport(task: PlannedTaskInput & { taskId: string; agentId: string }): AnalysisSessionOutcome | null {
    const artifacts = listArtifacts(db, runId).filter(artifact => artifact.taskId === task.taskId && artifact.type === 'analysis_report').reverse();
    for (const artifact of artifacts) {
      try {
        const report = AnalysisReportRecordSchema.parse(JSON.parse(readArtifact(db, paths, artifact.id).bytes.toString('utf8')));
        if (artifact.provenance['producer'] !== 'analysisRunner' || report.runId !== runId || report.taskId !== task.taskId || report.agentId !== task.agentId || report.baseRevision !== baseRevision) continue;
        return { ok: true, interrupted: false, taskId: task.taskId, attemptId: report.attemptId, agentId: task.agentId, reportArtifactId: artifact.id, report: report.report, reason: null, sessionStopped: true, sourceUnchanged: true };
      } catch { /* a corrupt/missing report cannot satisfy a resumed dependency */ }
    }
    return null;
  }

  function finish(reviewed: boolean, reason: string, interrupted = false): RunPlannedResult {
    finalizing = true;
    const runState = reviewed ? 'ready_for_review' : interrupted ? 'interrupted' : 'failed';
    input.ownership?.assertOwnership();
    const reportArtifactIds = tasks.flatMap(task => results.get(task.key)?.reportArtifactId ? [results.get(task.key)!.reportArtifactId!] : []);
    const finalReply = reviewed ? reason : null;
    const taskResults = tasks.map(task => ({ key: task.key, taskId: task.taskId, objective: task.objective, accepted: reviewed && results.get(task.key)?.ok === true, attempts: [], approved: null, repairsUsed: 0, interrupted: results.get(task.key)?.interrupted ?? false }));
    // Interruption receipts are immutable history. Only a terminal result occupies
    // result.json, so Resume can finish without rewriting an earlier receipt.
    const relativePath = interrupted ? `analysis/interruptions/${newId()}/result.json` : 'result.json';
    const manifestPath = path.join(paths.runArtifactsDir(runId), relativePath);
    writeArtifact(db, paths, { runId, type: 'analysis_result', relativePath, bytes: `${JSON.stringify({ manifestVersion: 1, workKind: 'analysis', runId, createdAt: run.createdAt, completedAt: nowIso(), request: { text: input.requestText, source: input.requestSource }, base: { revision: baseRevision, repoPath: run.projectRoot }, accepted: false, analysisReviewed: reviewed, reason, tasks: taskResults, reportArtifactIds, combination: null, headReview, finalReply, unresolved: run.unresolved }, null, 2)}\n`, provenance: { producer: 'analysisRunner', workKind: 'analysis', accepted: false, analysisReviewed: reviewed } });
    // Publish immutable evidence before any state or event advertises completion.
    transitionRun(db, runId, runState);
    if (reviewed) for (const task of tasks) if (getTask(db, task.taskId).state === 'validating') transitionTask(db, task.taskId, 'accepted');
    const finalPayload = finalReply ? { text: finalReply, summary: finalReply, headAgentId: input.headReview!.headAgentId, verificationStatus: 'reviewed_analysis', source: 'department_head_analysis_review', candidateRevision: baseRevision, artifactId: headReview?.artifactId ?? null, reportArtifactIds } : null;
    if (finalPayload) appendEvent(db, { runId, type: 'control.final_reply', payload: finalPayload });
    appendEvent(db, { runId, type: reviewed ? 'run.analysis_reviewed' : `run.${runState}`, payload: { workKind: 'analysis', analysisReviewed: reviewed, accepted: false, reason, reportArtifactIds } });
    if (finalPayload) {
      // A presentation callback cannot revoke a durably reviewed report.
      try { stream.event({ type: 'control.final_reply', runId, ...finalPayload }); stream.line(finalReply!); } catch { /* the read model can recover the durable final reply */ }
    }
    return { workKind: 'analysis', analysisReviewed: reviewed, runId, outcome: reviewed ? 'accepted' : interrupted ? 'interrupted' : 'failed', runState, runDir: run.runDir, baseRevision, tasks: taskResults, combination: null, reviewDecision: null, review: null, headReview, finalReply, accepted: false, reason, manifestPath, unresolved: run.unresolved };
  }
}
