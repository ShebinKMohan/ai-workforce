/** Live review and delivery projection shared by list, detail and CLI status. */
import type { DatabaseSync } from 'node:sqlite';

export function headReviewView(db: DatabaseSync, runId: string): { headReview: Record<string, unknown> | null; finalReply: string | null } {
  const latest = db.prepare("SELECT type, payload_json, timestamp FROM events WHERE run_id = ? AND type IN ('head.review_started', 'head.review_finished') ORDER BY sequence DESC LIMIT 1").get(runId) as { type: string; payload_json: string; timestamp: string } | undefined;
  const phase = latest ? JSON.parse(latest.payload_json) as Record<string, unknown> : null;
  const headReview = latest && phase ? { ...phase, state: latest.type === 'head.review_started' ? 'running' : phase['verdict'], at: latest.timestamp } : null;
  const replyEvent = db.prepare("SELECT payload_json FROM events WHERE run_id = ? AND type = 'control.final_reply' ORDER BY sequence DESC LIMIT 1").get(runId) as { payload_json: string } | undefined;
  const reply = replyEvent ? JSON.parse(replyEvent.payload_json) as Record<string, unknown> : null;
  return { headReview, finalReply: typeof reply?.['text'] === 'string' ? reply['text'] : null };
}
