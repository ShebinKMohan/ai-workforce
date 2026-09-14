import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const root = new URL('./', import.meta.url);
const base = 'http://127.0.0.1:4421';
const runId = '01a09c2b-8837-7478-9f99-51bb1d74c1f2';
const requestId = '01a09c2b-3994-706b-8497-9b123f734b81';
const runUrl = `${base}/api/projects/agents-office/runs/${runId}`;
async function get(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  return response.json();
}
const [detail, requests] = await Promise.all([get(runUrl), get(`${base}/api/requests`)]);
const request = requests.items.find((item) => item.id === requestId);
const before = JSON.parse(readFileSync(new URL('checkout-before.json', root), 'utf8'));
const git = (...args) => execFileSync('git', args, { cwd: before.project, encoding: 'utf8' });
const after = { project: before.project, head: git('rev-parse', 'HEAD').trim(), status: git('status', '--porcelain'), diff: git('diff') };
const checkoutUnchanged = ['head', 'status', 'diff'].every((field) => before[field] === after[field]);
const manifestRecord = detail.artifacts.find((item) => item.type === 'analysis_result');
if (!manifestRecord) throw new Error('No terminal analysis manifest');
const manifestDocument = await get(`${runUrl}/artifacts/${manifestRecord.id}`);
const manifest = JSON.parse(manifestDocument.text);
const proof = {
  capturedAt: new Date().toISOString(), runtime: 'Real installed Codex CLI 0.154.0; gpt-6-astra medium',
  submittedThrough: 'Headquarters browser composer; exact original request; Automatic team',
  request, runId, runState: detail.run.state, headReview: { state: detail.run.headReview.state, verdict: detail.run.headReview.verdict, sessionStopped: detail.run.headReview.sessionStopped },
  analysis: detail.analysis, manifest, taskViews: detail.taskViews,
  originalCheckoutUnchanged: checkoutUnchanged, noCodeVerificationCommands: detail.taskViews.every((task) => Object.values(task.receipts).every((count) => count === 0)),
  liveRequestsAfterCompletion: requests.live.length,
};
writeFileSync(new URL('live-run-final.json', root), JSON.stringify(detail, null, 2) + '\n');
writeFileSync(new URL('live-proof.json', root), JSON.stringify(proof, null, 2) + '\n');
writeFileSync(new URL('checkout-after.json', root), JSON.stringify(after, null, 2) + '\n');
writeFileSync(new URL('agents-office-reviewed-report.md', root), `# Agents Office: reviewed codebase report\n\nRequest: ${request.task}\n\nSource revision: ${detail.run.baseRevision}\n\n${detail.run.finalReply}\n`);
if (!checkoutUnchanged || !detail.analysis.reviewed || !detail.analysis.sourceUnchanged || detail.analysis.evidenceIssues.length || manifest.accepted !== false || manifest.analysisReviewed !== true || request.state !== 'ended' || request.exitCode !== 0) throw new Error('Live proof did not meet completion requirements');
console.log(JSON.stringify({ requestState: request.state, runId, analysis: detail.analysis, codeAccepted: manifest.accepted, originalCheckoutUnchanged: checkoutUnchanged, noCodeVerificationCommands: proof.noCodeVerificationCommands, liveRequestsAfterCompletion: requests.live.length }, null, 2));
