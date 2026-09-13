/** Office motion is a presentation of persisted receipts, never a scheduler.
 * Reserved workers, runtime prose, and decorative screens are not work evidence. */
const LIVE = new Set(['pending', 'running', 'waiting']);
const ATTENTION = new Set(['failed', 'interrupted', 'stalled', 'held', 'headReviewChanges', 'notStarted', 'noPlan', 'unverified']);
const id = value => typeof value === 'string' && value ? value : null;
const date = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const node = agentId => `agent:${agentId}`;

/** Pure mapping from the shared live task DTO. Exact actor IDs are captured in
 * the route, attempt, and review records, independent of today's saved roster. */
export function buildSceneActivity({ tasks = [], connected = true } = {}) {
  if (!connected) return { connected: false, receipts: [], activeNodes: [], phase: { stage: 'offline', label: 'Connection interrupted', detail: 'Activity paused until live records return', tone: 'attention' } };
  const receipts = [], active = new Map(), phases = [];
  for (const task of tasks) {
    const entry = task.entry || {}, request = entry.item || {}, run = entry.run || {};
    const project = id(task.projectId || entry.projectId) || 'workspace';
    const taskId = id(task.id || entry.key);
    if (!taskId) continue;
    const scope = JSON.stringify([project, id(request.id) || id(run.id) || taskId]);
    const receivedAt = date(request.receivedAt);
    const route = request.route || {}, review = run.headReview || {};
    const head = id(route.headAgentId) || id(review.headAgentId);
    const state = task.stateKey || entry.status?.key;
    const live = LIVE.has(run.state) && run.projectLock?.held === true && !request.stopRequestedAt && state !== 'stopping';
    const rows = Array.isArray(run.taskViews) ? run.taskViews : [];
    const participants = [];
    function receipt(stage, from, to, proof, at, tone = 'active') {
      receipts.push({ id: JSON.stringify([scope, stage, proof]), taskId, receivedAt, stage, from, to, at: date(at), tone });
    }
    function actor(agentNode, stage) {
      if (!active.has(agentNode)) active.set(agentNode, { node: agentNode, stage, taskId });
    }
    if (id(request.id) && receivedAt) receipt('received', 'message', 'control', request.id, request.receivedAt);
    const directReply = route.method === 'direct_reply';
    if (route.state === 'selected' && head && !directReply) receipt('routed', 'control', node(head), route.decidedAt || head, route.decidedAt);
    for (const row of rows) {
      const owner = id(row.ownerAgentId), attempt = row.attempt;
      // A real attempt is required. A pending plan or reserved roster is not a
      // dispatch, including when the roster lists several possible workers.
      if (!owner || !id(attempt?.id) || !attempt.startedAt) continue;
      if (!['running', 'succeeded', 'failed', 'interrupted', 'stopped'].includes(attempt.state) && !['validating', 'accepted', 'rejected'].includes(row.state)) continue;
      participants.push(owner);
      if (head && owner !== head) receipt('dispatched', node(head), node(owner), attempt.id, attempt.startedAt);
      if (row.state === 'validating' || Object.entries(row.receipts || {}).some(([key, value]) => key.startsWith('verifierExecuted') && value > 0)) {
        receipt('checking', node(owner), node(owner), attempt.id, row.lastEvent?.timestamp || attempt.endedAt);
      }
      if (live && row.state === 'running' && attempt.state === 'running') actor(node(owner), 'working');
      else if (live && row.state === 'validating') actor(node(owner), 'checking');
    }
    if (head && review.at && ['running', 'passed', 'changes_requested', 'blocked'].includes(review.state)) {
      for (const owner of new Set(participants)) if (owner !== head) receipt('reviewing', node(owner), node(head), `${review.reviewId || run.id}:${owner}`, review.at);
    }
    const finalReply = typeof run.finalReply === 'string' && run.finalReply.trim();
    if (head && review.state === 'passed' && finalReply) receipt('replied', node(head), 'control', `${review.reviewId || run.id}:${review.at || run.endedAt}`, run.endedAt || review.at, task.verified === true ? 'verified' : 'neutral');
    if (directReply && !request.runId && request.state === 'ended' && request.result?.code === 'control_reply' && (request.exitCode ?? request.result?.exitCode) === 0 && typeof request.controlReply === 'string' && request.controlReply.trim()) {
      receipt('answered', 'control', 'message', request.id, request.endedAt, 'neutral');
    }
    const routing = route.state === 'pending' && request.routingSession?.state === 'running' && !request.stopRequestedAt;
    if (routing) actor('control', 'routing');
    if (live && head && review.state === 'running') actor(node(head), 'reviewing');
    else if (live && head && state === 'planning') actor(node(head), 'planning');
    const hasWorking = live && rows.some(row => row.state === 'running' && row.attempt?.state === 'running' && row.attempt?.startedAt);
    let stage = 'idle', label = 'No active execution', tone = 'neutral', priority = 0;
    if (routing) { stage = 'routing'; label = 'Control Center is routing'; priority = 8; tone = 'active'; }
    else if (live && review.state === 'running') { stage = 'reviewing'; label = 'Department head is reviewing'; priority = 7; tone = 'review'; }
    else if (hasWorking) { stage = 'working'; label = 'Assigned agents are working'; priority = 6; tone = 'active'; }
    else if (live && state === 'checking') { stage = 'checking'; label = 'Independent verification'; priority = 5; tone = 'review'; }
    else if (live && state === 'planning') { stage = 'planning'; label = 'Department head is planning'; priority = 4; tone = 'active'; }
    else if (task.inMotion) { stage = 'waiting'; label = state === 'stopping' ? 'Stopping execution' : 'Waiting for execution'; priority = 3; tone = 'attention'; }
    else if (ATTENTION.has(state) || route.state === 'blocked') { stage = 'attention'; label = 'A task needs attention'; priority = 2; tone = 'attention'; }
    else if (task.verified === true && review.state === 'passed' && finalReply) { stage = 'verified'; label = 'Verified result returned'; priority = 1; tone = 'verified'; }
    phases.push({ stage, label, tone, priority, taskId, at: date(run.updatedAt || request.endedAt || request.receivedAt), detail: task.title || entry.title || '' });
  }
  phases.sort((a, b) => b.priority - a.priority || b.at - a.at);
  const phase = phases[0] || { stage: 'idle', label: 'No active execution', detail: 'Communication appears as tasks move through the workforce', tone: 'neutral' };
  if (phase.stage === 'attention') {
    const count = phases.filter(item => item.stage === 'attention').length;
    phase.label = `${count} ${count === 1 ? 'request needs' : 'requests need'} attention`;
  }
  return { connected: true, receipts, activeNodes: [...active.values()], phase };
}

/** Baseline and reconnect snapshots never replay historical activity. Receipt
 * IDs survive later task phases, while history loaded later is consumed quietly.
 * IDs are bounded per page. Old incoming receipts outside this session are never
 * replayed even after pruning. */
export function createSceneActivityTracker({ now = () => Date.now(), limit = 4000 } = {}) {
  const startedAt = now(), seen = new Set(), knownTasks = new Set();
  let baseline = true, previousReceipts = new Set();
  return {
    update(input) {
      const model = buildSceneActivity(input);
      if (!model.connected) { baseline = true; return { ...model, transfers: [] }; }
      const transfers = [];
      for (const receipt of model.receipts) {
        const known = knownTasks.has(receipt.taskId);
        if (!baseline && !previousReceipts.has(receipt.id) && !seen.has(receipt.id) && (known || receipt.receivedAt >= startedAt)) transfers.push(receipt);
        seen.add(receipt.id);
      }
      for (const task of input?.tasks || []) if (task?.id || task?.entry?.key) knownTasks.add(task.id || task.entry.key);
      while (seen.size > limit) seen.delete(seen.values().next().value);
      while (knownTasks.size > limit) knownTasks.delete(knownTasks.values().next().value);
      previousReceipts = new Set(model.receipts.map(receipt => receipt.id));
      baseline = false;
      const order = ['received', 'routed', 'dispatched', 'checking', 'reviewing', 'replied', 'answered'];
      transfers.sort((a, b) => a.at - b.at || order.indexOf(a.stage) - order.indexOf(b.stage));
      return { ...model, transfers };
    },
  };
}
