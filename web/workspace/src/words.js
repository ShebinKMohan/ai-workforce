/**
 * The words the page uses: one word per concept, in the user's own terms.
 *
 * On the page    In the CLI, API and schema
 * workspace      workspace
 * coding tool    runtime
 * project        project
 * check          acceptance check
 * department     department
 * department head  agent with role "head"
 * worker         agent with role "worker"
 * task           request (what you send), run (what it became)
 * part           task (what the head gives one worker)
 * copy           candidate workspace
 * verifier       verifier
 * verified       accepted with a verifier-executed passing receipt
 *
 * Record words (run, runtime, coordinator, candidate, branch, exit code, pid,
 * session, hashes) appear only inside "Show record", All events and Settings.
 */

export const APP_NAME = 'Workforce';

export const PHASES = [
  { key: 'send', number: 1, heading: 'Sent', line: 'You send it to a department.' },
  { key: 'decide', number: 2, heading: 'Department head', line: 'The department head decides who does it.' },
  { key: 'change', number: 3, heading: 'Work', line: 'A worker changes its own copy of the project.' },
  { key: 'check', number: 4, heading: 'Checks', line: 'The verifier runs your checks on the finished copy.' },
  { key: 'review', number: 5, heading: 'Review', line: 'You review the checked result.' },
];

export const HOW_IT_MOVES_NOTE = 'Only checks the verifier runs can mark work verified. A worker saying "done" marks nothing.';

export const COLOR_HEX = {
  blue: '#5595c4',
  slate: '#5b8daa',
  rose: '#d48897',
  sand: '#c7a160',
  lavender: '#a391bb',
  sage: '#7b9f8e',
};
export const COLOR_ORDER = ['blue', 'slate', 'rose', 'sand', 'lavender', 'sage'];

export const TOOL_NAMES = { codex: 'Codex', 'claude-code': 'Claude Code', fake: 'Test tool' };
export const TOOL_LOGIN = { codex: 'codex login', 'claude-code': 'claude auth login' };

export const SETUP = {
  heading: 'Welcome to Workforce',
  lines: ['Your workspace is empty. You decide which projects, departments and workers it holds.', 'Nothing runs and no model is called until you send a task.'],
  steps: {
    tools: { title: 'Check your coding tools', text: 'A coding tool is a program on this computer that does the work, such as Codex or Claude Code. Workforce looked for them without starting either one.' },
    project: { title: 'Add a project', text: 'A project is a Git repository on this computer with at least one check: a command, such as npm test, that the verifier runs. Workers never change your folder; each gets its own copy.' },
    department: { title: 'Create a department', text: 'A department is a department head and the workers it hands tasks to.' },
    send: { title: 'Send your first task', text: 'Describe a change. The department head decides which worker does it.' },
  },
};

export const EMPTY = {
  tasks: 'No tasks yet. Tasks you send appear here, with every recorded step.',
  projects: 'No projects yet. A project is a Git repository on this computer.',
  departments: 'No departments yet. A department is a department head and the workers it hands tasks to.',
  needsYou: 'Nothing needs you.',
  inMotion: 'Nothing is in motion.',
  history: 'No tasks on this project yet.',
};

export const ERRORS = {
  unreachable: "Workforce's page server is not answering, so nothing on this page is current. Is workforce serve still running in its terminal?",
  streamLost: 'Live updates stopped. What you see may be out of date. Reconnecting…',
  workspaceUnreadable: 'Your workspace file could not be read, so nothing can be sent or changed from this page. Workforce never overwrites a file it cannot read.',
  revisionConflict: 'The workspace changed since this page read it, so nothing was saved. Your edits are still here.',
  lockBusy: 'Another change is being saved right now. Try again in a moment.',
  noTools: 'No coding tool found. Workforce works with Codex and Claude Code. Adding a project does not need one.',
  discoveryFailed: 'Could not check for coding tools. Nothing was started.',
  queueElsewhere: 'Another Workforce page server manages tasks for this workspace. Use that page, or stop it first.',
};

/** Status words for a task, with the tone that may colour them. Green (`verified`) is used by exactly one. */
export const TASK_STATUS = {
  waiting: { word: 'Waiting', tone: 'pending' },
  held: { word: 'Waiting for your go-ahead', tone: 'attention' },
  starting: { word: 'Starting', tone: 'pending' },
  planning: { word: 'Department head is planning', tone: 'active' },
  working: { word: 'Working', tone: 'active' },
  checking: { word: 'Being checked', tone: 'active' },
  headReviewing: { word: 'Department head reviewing', tone: 'active' },
  headReviewChanges: { word: 'Head requested changes', tone: 'attention' },
  verified: { word: 'Verified', tone: 'verified' },
  unverified: { word: 'Finished, not verified', tone: 'attention' },
  failed: { word: 'Did not finish', tone: 'failed' },
  noPlan: { word: 'No usable plan', tone: 'failed' },
  notStarted: { word: 'Not started', tone: 'failed' },
  interrupted: { word: 'Stopped', tone: 'attention' },
  stalled: { word: 'Stalled', tone: 'failed' },
  stopping: { word: 'Stopping', tone: 'pending' },
  discarded: { word: 'Discarded', tone: 'neutral' },
  ended: { word: 'Ended', tone: 'neutral' },
  answered: { word: 'Answered', tone: 'neutral' },
};

export const TONE_ICON = {
  verified: '✓',
  active: '●',
  pending: '○',
  attention: '!',
  failed: '×',
  neutral: '·',
};

/** "waiting: another task is running on X" → "Another task is running on X." */
export function plainReason(reason) {
  if (typeof reason !== 'string' || reason.trim().length === 0) return null;
  const text = reason.replace(/^(waiting|held|stopping):\s*/i, '').trim();
  const sentence = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

export function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

export function toolName(adapter) {
  return TOOL_NAMES[adapter] ?? adapter;
}
