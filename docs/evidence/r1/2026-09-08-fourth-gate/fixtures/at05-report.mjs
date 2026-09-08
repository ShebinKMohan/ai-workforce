// at05-report.mjs <stateDir> <label> — pulls the AT05 evidence out of one run's own state.
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
const stateDir = process.argv[2];
const db = new DatabaseSync(path.join(stateDir, 'state.sqlite'), { readOnly: true });
const runs = db.prepare('SELECT id,state FROM runs ORDER BY rowid').all();
const runId = runs[runs.length - 1].id;
console.log(`## run ${runId} state=${runs[runs.length-1].state}`);

const tasks = db.prepare('SELECT id,objective,state FROM tasks WHERE run_id=? ORDER BY rowid').all(runId);
console.log('\n### tasks');
for (const t of tasks) console.log(`${t.id}\t${t.state}\t${JSON.stringify(t.objective.slice(0,80))}`);

const msgs = db.prepare('SELECT * FROM messages WHERE run_id=? ORDER BY rowid').all(runId);
console.log(`\n### messages (${msgs.length} row(s))`);
for (const m of msgs) console.log(JSON.stringify(m));

console.log('\n### coordination.* events');
const evs = db.prepare("SELECT sequence,timestamp,type,task_id,payload_json FROM events WHERE run_id=? AND type LIKE 'coordination%' ORDER BY sequence").all(runId);
for (const e of evs) console.log(`${e.timestamp} ${e.type} task=${(e.task_id??'').slice(-12)} ${e.payload_json}`);

console.log('\n### timeline');
const want = new Set(['task.created','turn.started','runtime.turn_completed','runtime.stopped','attempt.started','coordination.delivered','coordination.delivery_failed','coordination.attached','run.accepted','run.failed','task.accepted']);
const all = db.prepare('SELECT timestamp,type,task_id FROM events WHERE run_id=? ORDER BY sequence').all(runId);
const keyOf = new Map(tasks.map((t,i)=>[t.id, t.objective.slice(0,18)]));
let t0=null;
for (const r of all) { if(!want.has(r.type)) continue; if(t0===null) t0=Date.parse(r.timestamp);
  console.log(`+${((Date.parse(r.timestamp)-t0)/1000).toFixed(1).padStart(7)}s  ${r.type.padEnd(26)} ${keyOf.get(r.task_id)??''}`); }

// raw adapter capture: every turn/steer the coordinator sent, verbatim
const logsDir = path.join(stateDir, 'runs', runId, 'artifacts', 'logs');
console.log('\n### raw turn/steer requests (adapter capture)');
if (!existsSync(logsDir)) console.log('(no logs dir)');
else for (const f of readdirSync(logsDir)) {
  if (!f.endsWith('.jsonl')) continue;
  const lines = readFileSync(path.join(logsDir,f),'utf8').split('\n').filter(Boolean);
  const steers = lines.filter(l => l.includes('turn/steer') || l.includes('coordinator message'));
  if (steers.length===0) continue;
  console.log(`# ${f}`);
  for (const s of steers) console.log(s.length>1600?s.slice(0,1600)+'…':s);
}
console.log('\n### "[object Object]" occurrences in raw capture');
let oo=0, files=0;
if (existsSync(logsDir)) for (const f of readdirSync(logsDir)) { if(!f.endsWith('.jsonl')) continue; files++;
  oo += (readFileSync(path.join(logsDir,f),'utf8').match(/\[object Object\]/g)??[]).length; }
console.log(`${oo} in ${files} capture file(s)`);
