// List every mcpToolCall a codex session actually made, beside any agent claim
// about the peer channel being unavailable. Argument: one raw capture .jsonl.
import { readFileSync } from 'node:fs';
for (const l of readFileSync(process.argv[2], 'utf8').trim().split('\n')) {
  let j; try { j = JSON.parse(l); } catch { continue; }
  let inner; try { inner = JSON.parse(j.line); } catch { continue; }
  const it = inner.params?.item;
  if (inner.method === 'item/completed' && it?.type === 'mcpToolCall') console.log(`  atMs=${j.atMs} TOOLCALL ${it.tool} status=${it.status}`);
  if (inner.method === 'item/completed' && it?.type === 'agentMessage' && /registered|reachable|mailbox|peer message was attempted/i.test(it.text ?? '')) console.log(`  atMs=${j.atMs} CLAIM: ${it.text.slice(0, 240).replace(/\n/g, ' ')}`);
}
