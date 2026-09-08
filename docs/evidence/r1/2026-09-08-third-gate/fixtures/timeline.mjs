import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const want = new Set(['task.created','turn.started','runtime.turn_completed','runtime.stopped','attempt.started','coordination.delivered','coordination.delivery_failed','coordination.attached','run.accepted','task.accepted']);
const rows = db.prepare('SELECT timestamp,type,task_id,payload_json FROM events ORDER BY sequence').all();
let t0 = null;
for (const r of rows) {
  if (!want.has(r.type)) continue;
  if (t0 === null) t0 = Date.parse(r.timestamp);
  const off = ((Date.parse(r.timestamp) - t0) / 1000).toFixed(1).padStart(7);
  console.log(`+${off}s  ${r.timestamp}  ${r.type.padEnd(28)} ${(r.task_id ?? '').slice(-12)}`);
}
