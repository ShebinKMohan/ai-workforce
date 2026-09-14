/** Read-only report evidence. Analysis is a reviewed report, never code acceptance. */
import type { StateStore } from './db.js';
import { listArtifacts, readArtifact } from './artifacts.js';

type ObjectRecord = Record<string, unknown>;
const object = (value: unknown): ObjectRecord | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectRecord : null;
const text = (value: unknown): string => typeof value === 'string' ? value : '';
function latestPayload(store: StateStore, runId: string, type: string): ObjectRecord | null {
  const row = store.db.prepare('SELECT payload_json FROM events WHERE run_id = ? AND type = ? ORDER BY sequence DESC LIMIT 1').get(runId, type) as { payload_json: string } | undefined;
  try { return row ? object(JSON.parse(row.payload_json) as unknown) : null; } catch { return null; }
}

export interface AnalysisEvidence {
  workKind: 'analysis' | 'implementation';
  analysis: null | {
    reviewed: boolean;
    sourceUnchanged: boolean;
    reportCount: number;
    reportArtifactIds: string[];
    evidenceIssues: string[];
  };
}

/** The caller supplies only the result manifest already checked against its artifact receipt. */
export function analysisEvidenceView(store: StateStore, runId: string, manifest: ObjectRecord | null, priorIssues: ReadonlyArray<string> = []): AnalysisEvidence {
  const created = latestPayload(store, runId, 'run.created');
  if (created?.['workKind'] !== 'analysis' && manifest?.['workKind'] !== 'analysis') return { workKind: 'implementation', analysis: null };
  const issues = [...priorIssues];
  const records = listArtifacts(store.db, runId);
  const baseRevision = object(manifest?.['base'])?.['revision'];
  const identifiers = Array.isArray(manifest?.['reportArtifactIds']) ? manifest['reportArtifactIds'].filter((id): id is string => typeof id === 'string') : [];
  const uniqueIds = [...new Set(identifiers)];
  const sameIds = (value: unknown) => Array.isArray(value) && value.length === uniqueIds.length && new Set(value).size === uniqueIds.length && value.every((id: unknown) => typeof id === 'string' && uniqueIds.includes(id));
  let sourceUnchanged = uniqueIds.length > 0;
  if (manifest?.['analysisReviewed'] === true) {
    if (!Array.isArray(manifest['reportArtifactIds']) || manifest['reportArtifactIds'].length !== identifiers.length || identifiers.length !== uniqueIds.length || uniqueIds.length === 0) issues.push('The reviewed analysis has no complete report receipt list.');
    if (manifest['runId'] !== runId || typeof baseRevision !== 'string') issues.push('The analysis manifest does not identify this run and its source revision.');
    if (manifest['accepted'] !== false) issues.push('The analysis manifest does not explicitly separate its report from code acceptance.');
    for (const id of uniqueIds) {
      const artifact = records.find(item => item.id === id && item.type === 'analysis_report');
      if (!artifact || artifact.provenance['producer'] !== 'analysisRunner') { issues.push('A required analysis report receipt is unavailable.'); sourceUnchanged = false; continue; }
      try {
        const report = object(JSON.parse(readArtifact(store.db, store.paths, id).bytes.toString('utf8')) as unknown);
        if (!report || report['runId'] !== runId || report['taskId'] !== artifact.taskId || report['baseRevision'] !== baseRevision || report['sourceUnchanged'] !== true) { issues.push('An analysis report does not establish unchanged source.'); sourceUnchanged = false; }
        if (!report || report['sessionStopped'] !== true || typeof report['toolCallCount'] !== 'number' || !Number.isSafeInteger(report['toolCallCount']) || report['toolCallCount'] <= 0 || !text(report['report']).trim()) issues.push('An analysis report lacks inspection, report text, or a stopped-session receipt.');
      } catch { issues.push('A required analysis report is missing or has changed.'); sourceUnchanged = false; }
    }
    const finalReply = latestPayload(store, runId, 'control.final_reply');
    const reviewed = latestPayload(store, runId, 'run.analysis_reviewed');
    const headReview = object(manifest['headReview']);
    if (!reviewed || reviewed['analysisReviewed'] !== true || !sameIds(reviewed['reportArtifactIds']) || !sameIds(finalReply?.['reportArtifactIds']) || finalReply?.['verificationStatus'] !== 'reviewed_analysis' || finalReply['source'] !== 'department_head_analysis_review') issues.push('The analysis delivery receipt is incomplete.');
    if (!headReview || headReview['verdict'] !== 'passed' || headReview['candidateRevision'] !== baseRevision || headReview['sessionStopped'] !== true) issues.push('The department head review is not recorded.');
    const reviewArtifact = records.find(item => item.id === headReview?.['artifactId'] && item.type === 'head_review_result' && item.provenance['producer'] === 'headReviewer');
    if (!reviewArtifact) issues.push('The department head review receipt is unavailable.');
    else {
      try {
        const receipt = object(JSON.parse(readArtifact(store.db, store.paths, reviewArtifact.id).bytes.toString('utf8')) as unknown);
        if (!receipt || receipt['verdict'] !== 'passed' || receipt['sessionStopped'] !== true || receipt['reviewId'] !== headReview?.['reviewId'] || receipt['candidateRevision'] !== headReview?.['candidateRevision'] || finalReply?.['artifactId'] !== reviewArtifact.id) issues.push('The department head review does not match the delivered analysis.');
      } catch { issues.push('The department head review receipt is missing or has changed.'); }
    }
  } else {
    sourceUnchanged = false;
  }
  return { workKind:'analysis', analysis:{ reviewed:manifest?.['analysisReviewed'] === true && issues.length === 0, sourceUnchanged, reportCount:uniqueIds.length, reportArtifactIds:uniqueIds, evidenceIssues:issues } };
}
