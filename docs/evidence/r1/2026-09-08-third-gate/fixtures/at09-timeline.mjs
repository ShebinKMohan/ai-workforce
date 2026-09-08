import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const tasks = new Map();
for (const t of db.prepare('SELECT id, objective FROM tasks').all()) {
  const o = t.objective;
  const key = o.startsWith('Create the file docs/fast.md') ? 'fast'
    : o.startsWith('Create the file docs/dependent.md') ? 'dependent'
    : o.startsWith('This task is deliberately slow') ? 'slow' : '?';
  tasks.set(t.id, key);
}
const want = new Set(['task.created','turn.started','runtime.turn_completed','runtime.stopped','task.accepted']);
const rows = db.prepare('SELECT timestamp,type,task_id FROM events ORDER BY sequence').all().filter(r => want.has(r.type));
const t0 = Date.parse(rows[0].timestamp);
for (const r of rows) {
  const off = ((Date.parse(r.timestamp) - t0) / 1000).toFixed(1).padStart(7);
  console.log(`+${off}s  ${r.type.padEnd(24)} ${tasks.get(r.task_id) ?? ''}`);
}
