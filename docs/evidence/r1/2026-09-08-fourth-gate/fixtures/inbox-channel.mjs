// Did the recipient's own read_inbox also carry the fact, or only the push?
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
const [ , , stateDir, runId, word ] = process.argv;
const dir = path.join(stateDir, 'runs', runId, 'artifacts', 'logs');
if (!existsSync(dir)) { console.log('no logs dir'); process.exit(0); }
for (const f of readdirSync(dir)) {
  if (!f.endsWith('.jsonl')) continue;
  const lines = readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean);
  let steer = 0, inboxHits = 0, firstSteerMs = null, firstInboxMs = null;
  for (const l of lines) {
    let r; try { r = JSON.parse(l); } catch { continue; }
    const s = r.line ?? '';
    if (s.includes('turn/steer') && s.includes(word)) { steer++; firstSteerMs ??= r.atMs; }
    if (s.includes('read_inbox') && s.includes(word)) { inboxHits++; firstInboxMs ??= r.atMs; }
  }
  console.log(`${f}: turn/steer frames carrying "${word}": ${steer} (first at ${firstSteerMs}ms) · read_inbox frames carrying it: ${inboxHits} (first at ${firstInboxMs}ms)`);
}
