// Every coordination tool call the runtime actually made, with its result.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
const [ , , stateDir ] = process.argv;
const runsDir = path.join(stateDir, 'runs');
for (const runId of readdirSync(runsDir)) {
  const dir = path.join(runsDir, runId, 'artifacts', 'logs');
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const lines = readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean);
    const calls = [];
    for (const l of lines) {
      let r; try { r = JSON.parse(l); } catch { continue; }
      const s = r.line ?? '';
      if (!s.includes('mcpToolCall') && !s.includes('send_message') && !s.includes('read_inbox')) continue;
      let p; try { p = JSON.parse(s); } catch { continue; }
      const item = p?.params?.item;
      if (item?.type !== 'mcpToolCall') continue;
      if (p.method !== 'item/completed') continue;
      calls.push({ atMs: r.atMs, tool: item.tool ?? item.name ?? '?', server: item.server ?? '', status: item.status ?? '', result: JSON.stringify(item.result ?? item.output ?? item.error ?? '').slice(0, 400) });
    }
    console.log(`## ${f} — ${calls.length} completed mcpToolCall item(s)`);
    for (const c of calls) console.log(`   atMs=${c.atMs} ${c.server}/${c.tool} status=${c.status} ${c.result}`);
  }
}
