import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
const [ , , stateDir, runId, word ] = process.argv;
const dir = path.join(stateDir, 'runs', runId, 'artifacts', 'logs');
for (const f of readdirSync(dir)) {
  if (!f.endsWith('.jsonl')) continue;
  const lines = readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean);
  const hits = [];
  for (const l of lines) {
    let r; try { r = JSON.parse(l); } catch { continue; }
    const s = r.line ?? '';
    if (!s.includes(word)) continue;
    let m = 'unknown'; try { m = JSON.parse(s).method ?? `response id=${JSON.parse(s).id}`; } catch {}
    let kind = '';
    try { const p = JSON.parse(s); kind = p?.params?.item?.type ?? ''; } catch {}
    hits.push(`${r.dir} atMs=${r.atMs} ${m} ${kind}`);
  }
  console.log(`## ${f} — ${hits.length} frame(s) contain "${word}"`);
  for (const h of hits.slice(0, 40)) console.log('   ' + h);
}
