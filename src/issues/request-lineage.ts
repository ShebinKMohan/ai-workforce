/** Read only the queue's explicit retry lineage; a matching project or run alone is not a retry. */
import type { RequestItem } from '../server/requests.js';
import type { IssueRecord } from './contracts.js';

export interface IssueRequestSelection {
  original: RequestItem | null;
  current: RequestItem | null;
  /** The selected receipt is still present in the queue, including terminal receipts. */
  live: RequestItem | null;
  conflict: string | null;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const runOf = (item: RequestItem) => item.runId ?? item.resumeRunId;
const preserved = ['submittedDepartmentId', 'submittedControlCenter', 'submittedWorkKind', 'mode', 'priorRequestId', 'conversation', 'submittedAttachmentIds', 'attachments', 'controlCenter', 'controlRuntime'] as const;

/** A receipt may acquire routing/results, but never change its submission identity. */
function sameReceipt(saved: RequestItem, candidate: RequestItem): boolean {
  if (['id', 'clientRequestId', 'projectId', 'kind', 'task', 'resumeRunId', 'retryOfRequestId', 'retryRootRequestId', 'retryAttempt', 'retryReason'].some(key => !same(saved[key as keyof RequestItem], candidate[key as keyof RequestItem]))) return false;
  if (saved.runId && candidate.runId !== saved.runId) return false;
  return preserved.every(key => same(saved[key], candidate[key]));
}

function retryOf(parent: RequestItem, child: RequestItem, rootId: string): boolean {
  if (child.id === parent.id || child.projectId !== parent.projectId || child.task !== parent.task || !child.clientRequestId
      || child.retryOfRequestId !== parent.id || child.retryRootRequestId !== rootId
      || child.retryAttempt !== (parent.retryAttempt ?? 0) + 1 || !['manual', 'provider_transient'].includes(child.retryReason ?? '')) return false;
  if (!['ended', 'failed_to_start'].includes(parent.state) || parent.stopRequestedAt || parent.exitCode === 130 || parent.signal === 'SIGINT'
      || parent.routingSession && parent.routingSession.state !== 'stopped') return false;
  if (parent.endedAt && Date.parse(child.receivedAt) < Date.parse(parent.endedAt)) return false;
  const runId = runOf(parent);
  if (runId) return child.kind === 'resume' && child.retryFailed === true && child.retryReason === 'manual'
    && child.resumeRunId === runId && (child.runId === null || child.runId === runId) && same(parent.attachments, child.attachments);
  if (parent.state === 'ended' && parent.exitCode === 0) return false;
  return child.kind === 'request' && child.resumeRunId === null && preserved.every(key => same(parent[key], child[key]))
    && (parent.approvedRosterHash === undefined || child.approvedRosterHash === parent.approvedRosterHash)
    && (parent.workKind === undefined || child.workKind === parent.workKind);
}

function retainedBranchConflict(original: RequestItem, tip: RequestItem, requests: readonly RequestItem[]): string | null {
  const conflict = 'Conflicting retained retry ancestry prevents selecting an issue result.';
  let parent = original;
  const seen = new Set([parent.id]);
  // Check the retained prefix even when the durable tip skips pruned history.
  for (let index = 0; index <= requests.length; index++) {
    const children = requests.filter(item => retryOf(parent, item, original.id));
    if (children.length > 1) return conflict;
    const next = children[0];
    if (!next || next.id === tip.id) break;
    if (seen.has(next.id) || next.retryAttempt! >= tip.retryAttempt!
        || next.retryAttempt === tip.retryAttempt! - 1 && next.id !== tip.retryOfRequestId) return conflict;
    seen.add(next.id); parent = next;
  }
  // Also check the retained suffix against the exact parent IDs committed in
  // the saved tip. A sibling still conflicts when the selected child was pruned.
  let child = tip;
  for (let index = 0; index <= requests.length; index++) {
    const parents = child.retryOfRequestId === original.id ? [original] : requests.filter(item => item.id === child.retryOfRequestId);
    if (parents.length > 1) return conflict;
    const previous = parents[0];
    if (!previous) break;
    if (!retryOf(previous, child, original.id)) return conflict;
    if (requests.some(item => item.id !== child.id && retryOf(previous, item, original.id))) return conflict;
    if (previous.id === original.id) break;
    child = previous;
  }
  return null;
}

export function selectIssueRequest(issue: IssueRecord, requests: readonly RequestItem[]): IssueRequestSelection {
  const empty: IssueRequestSelection = { original: null, current: null, live: null, conflict: null };
  const dispatch = issue.dispatch;
  if (!dispatch) return empty;
  const matchesOriginal = (item: RequestItem) => item.kind === 'request' && item.clientRequestId === dispatch.clientRequestId
    && item.projectId === issue.projectId && item.task === dispatch.task && !item.retryOfRequestId && !item.retryRootRequestId;
  const saved = dispatch.request;
  if (saved && !matchesOriginal(saved)) return { ...empty, conflict: 'The saved original request does not match this issue submission.' };
  const roots = requests.filter(matchesOriginal);
  if (roots.length > 1 || saved && roots.some(item => !sameReceipt(saved, item))) return { ...empty, original: saved, current: saved, conflict: 'Conflicting original request receipts prevent following this issue.' };
  const original = roots[0] ?? saved;
  if (!original) return empty;
  let current = original;
  let live: RequestItem | null = roots[0] ?? null;
  // This tip was admitted by recordRequests while all predecessor receipts
  // were still retained. It is an anchor, not a root chosen from a loose retryRootRequestId.
  const tip = dispatch.retryRequest;
  if (dispatch.retryConflict) return { original, current: tip ?? original, live: null, conflict: dispatch.retryConflict };
  if (tip) {
    if (tip.projectId !== issue.projectId || tip.task !== dispatch.task || tip.retryRootRequestId !== original.id
        || !tip.retryOfRequestId || !tip.retryAttempt || tip.id === original.id) return { original, current: original, live, conflict: 'The saved retry receipt does not match this issue lineage.' };
    const fresh = requests.filter(item => item.id === tip.id);
    if (fresh.length > 1 || fresh.some(item => !sameReceipt(tip, item))) return { original, current: tip, live: null, conflict: 'Conflicting retry receipts prevent following this issue.' };
    current = fresh[0] ?? tip;
    live = fresh[0] ?? null;
    const conflict = retainedBranchConflict(original, current, requests);
    if (conflict) return { original, current, live, conflict };
  }
  const visited = new Set([original.id, current.id]);
  for (let index = 0; index <= requests.length; index++) {
    const successors = requests.filter(item => retryOf(current, item, original.id));
    if (successors.length > 1) return { original, current, live, conflict: 'More than one retry claims this request. Inspect its history before treating either as the issue result.' };
    const next = successors[0];
    if (!next) return { original, current, live, conflict: null };
    if (visited.has(next.id)) return { original, current, live, conflict: 'The saved retry lineage contains a cycle.' };
    visited.add(next.id); current = next; live = next;
  }
  return { original, current, live, conflict: 'The saved retry lineage could not be resolved.' };
}
