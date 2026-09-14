import { assignments as seeds } from './data.js';
import { departments, activeDepartments } from './organization.js';

// Local UI demonstrations only. These functions do not call models, execute work,
// grant access, or establish that any review or recovery attempt actually occurred.
const legacyReviewSeeds = {
  'HQ-1044': {
    title: 'Review the new onboarding experience',
    summary: 'The proposed five-step onboarding flow is ready for your review. Approve the direction or request changes before the team prepares the implementation handoff.',
  },
  'HQ-1045': {
    title: 'Approve the Launchpad campaign brief',
    summary: 'Review the launch narrative, target audience, and proposed channel mix. Approval confirms the brief so the team can begin drafting the campaign assets.',
  },
};

/** Migrate previous demonstration records without replacing user-authored content. */
export function normalizeAssignment(assignment) {
  const result = { ...assignment };
  if (result.status === 'Needs approval') {
    result.status = 'Internal review';
    if (result.due === 'Your decision') result.due = 'Head review';
  }
  if (!result.ownerId) {
    const department = departments.find(candidate => candidate.id === result.department);
    const owner = department && [...department.members, department.lead].find(member => member.name === result.owner);
    if (owner) result.ownerId = owner.id;
    else if (result.owner === 'Atlas') result.ownerId = 'atlas';
  }
  const legacy = legacyReviewSeeds[result.id];
  const current = legacy && seeds.find(seed => seed.id === result.id);
  if (!current) return result;
  if (result.title === legacy.title) result.title = current.title;
  if (typeof result.summary === 'string' && result.summary.startsWith(legacy.summary)) {
    // Previous versions appended feedback to the summary. Keep that suffix intact.
    result.summary = current.summary + result.summary.slice(legacy.summary.length);
  }
  return result;
}

// Strong domain words outweigh broad action words such as "build" or "analyze".
// Unknown or equally strong cross-department briefs remain with Atlas for planning.
const departmentSignals = [
  ['research', /\b(research|competitor|interviews?|market|insights?|segments?)\b/gi, /\b(compare|analy[sz]e|investigate)\b/gi],
  ['engineering', /\b(engineering|code|bugs?|api|software|tests?|testing|release|deploy|debug|database|analytics|integration|integrate|implement)\b/gi, /\b(build|app|feature|fix)\b/gi],
  ['design', /\b(design|ui|ux|prototype|interface|screens?|visual|brand)\b/gi, /\b(layout|onboarding)\b/gi],
  ['marketing', /\b(marketing|launch|campaign|content|audience|social|seo|newsletter)\b/gi, /\b(promote|copy|messaging)\b/gi],
  ['operations', /\b(operations|process|handoff|workflow|schedule|vendor|procurement)\b/gi, /\b(organize|coordinate)\b/gi],
  ['support', /\b(support|helpdesk|tickets?|guide|faq|troubleshoot)\b/gi, /\b(customer service|knowledge base)\b/gi],
];

export function suggestedDepartment(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const words = new Set(text.toLowerCase().match(/[a-z]{3,}/g) || []);
  const scores = activeDepartments().map(department => {
    const signal = departmentSignals.find(([id]) => id === department.id);
    const domainScore = signal ? (text.match(signal[1])?.length || 0) * 3 + (text.match(signal[2])?.length || 0) : 0;
    const named = text.toLowerCase().includes(department.name.toLowerCase());
    const purposeWords = new Set((department.purpose || department.focus || '').toLowerCase().match(/[a-z]{4,}/g) || []);
    const stopwords = new Set(['with', 'from', 'into', 'that', 'this', 'your', 'their', 'every', 'team', 'work', 'tasks', 'help', 'make', 'keep']);
    const purposeScore = signal ? 0 : [...purposeWords].filter(word => !stopwords.has(word) && words.has(word)).length;
    return { id: department.id, score: domainScore + (named ? 6 : 0) + purposeScore };
  }).sort((a, b) => b.score - a.score);
  return scores[0]?.score > 0 && scores[0].score > (scores[1]?.score || 0) ? scores[0].id : null;
}

/** Conservative distinction between asking for work and asking about work. */
export function isTaskRequest(text) {
  if (typeof text !== 'string') return false;
  const input = text.trim().replace(/^(?:hey|hi|hello)[,!]?\s+/i, '');
  if (!input || /^(?:hey|hi|hello|thanks|thank you|good (?:morning|afternoon|evening))[!.?\s]*$/i.test(input)) return false;
  if (/^(?:(?:can|could|would) you |please )?(?:show|tell|give) me (?:the |a |an |our |my )?(?:status|update|progress|summary|briefing|assignments|tasks|blockers|team|daily brief)\b/i.test(input)) return false;
  if (/^(?:what(?:'s| is| are)|how(?:'s| is| are)|who(?:'s| is| are)|where(?:'s| is| are)|any updates?\b|status\b)/i.test(input)) return false;
  return /^(?:(?:please|kindly|also)\s+|(?:can|could|would|will) you\s+|(?:i|we) (?:want|need)(?: you)? to\s+|(?:i|we) need you to\s+)*(?:add|extend|revise|continue|build|create|design|draft|write|prepare|plan|research|compare|analy[sz]e|investigate|fix|debug|test|implement|develop|refine|review|map|connect|organize|schedule|update|improve|polish|make|send|publish|deploy|resolve|audit|summari[sz]e|help me)\b/i.test(input);
}

/** Balance real assignment counts; the illustration's member status is not workload. */
export function selectOwner(departmentId, assignments = []) {
  const department = activeDepartments().find(candidate => candidate.id === departmentId);
  if (!department) return null;
  const members = department.members.filter(member => !member.archived);
  if (!members.length) return department.lead && !department.lead.archived ? department.lead.name : null;
  const counts = new Map(members.map(member => [member.id, 0]));
  const seen = new Set();
  for (const assignment of assignments) {
    if (!assignment || assignment.department !== departmentId || ['Completed', 'Cancelled'].includes(assignment.status)) continue;
    // A duplicate stored row should not inflate a teammate's load.
    if (assignment.id && seen.has(assignment.id)) continue;
    if (assignment.id) seen.add(assignment.id);
    const ownerId = assignment.ownerId || members.find(member => member.name === assignment.owner)?.id;
    if (counts.has(ownerId)) counts.set(ownerId, counts.get(ownerId) + 1);
  }
  return members.reduce((least, member) => counts.get(member.id) < counts.get(least.id) ? member : least).name;
}

/** Construct one queued record; callers control insertion and persistence. */
export function createAssignment({ text, departmentId, assignments = [], attachments = [] }) {
  const brief = typeof text === 'string' ? text.trim() : '';
  if (!brief) throw new TypeError('An assignment needs a nonempty brief.');
  const candidate = activeDepartments().find(department => department.id === departmentId);
  const ownerName = selectOwner(candidate?.id, assignments);
  const department = ownerName ? candidate.id : null;
  const owner = department && [...candidate.members.filter(member => !member.archived), candidate.lead].find(member => member.name === ownerName);
  return {
    id: `HQ-${crypto.randomUUID()}`,
    title: brief.length > 90 ? `${brief.slice(0, 87)}…` : brief,
    summary: brief,
    department,
    owner: ownerName || 'Atlas',
    ownerId: owner?.id || 'atlas',
    status: 'Queued',
    due: 'Team planning',
    deliverable: 'A reviewed response to your brief, with supporting evidence',
    attachments: attachments.map(attachment => typeof attachment === 'object' && attachment !== null ? { ...attachment } : attachment),
  };
}

const meaningful = value => typeof value === 'string' && value.trim().length >= 8;
const unsuccessfulResult = /\b(?:no\b.+\b(?:access|connection|reference|export|permission|available|found)|not (?:available|found|permitted|authorized|granted)|unavailable|cannot|can't|could not|couldn't|denied|failed|exhausted|missing|does not include|insufficient|blocked)\b/i;
const routineReviewRequest = /\b(?:approve|approval|review|sign[- ]off)\b.{0,30}\b(?:draft|direction|design|prototype|brief|copy|onboarding)\b|\b(?:draft|direction|design|prototype|brief)\b.{0,30}\b(?:approval|review|sign[- ]off)\b/i;

/** A demonstration gate: a review request alone never becomes a human blocker. */
export function canEscalate(input = {}) {
  const { attempts, needs, reason } = input || {};
  return meaningful(reason) && meaningful(needs) && !routineReviewRequest.test(needs) && Array.isArray(attempts) && attempts.some(attempt =>
    meaningful(attempt?.action) && meaningful(attempt?.result) && unsuccessfulResult.test(attempt.result)
  );
}
