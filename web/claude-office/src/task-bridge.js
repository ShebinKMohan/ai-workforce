import { postJson } from '../../workspace/src/api.js';
import { controlCenterSubmission } from './chat-model.js';

/** Submit the route already displayed and confirmed in the inline composer. */
export async function submitTask(context, workspaceDocument) {
  const payload = controlCenterSubmission(context, workspaceDocument);
  const result = await postJson('/api/requests', payload);
  return { task: result.request };
}

// Keep the existing shell callback compatible while task intake moves inline.
export const reviewTask = submitTask;
