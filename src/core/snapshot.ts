/**
 * Immutable agent snapshots (FR012, FR015).
 *
 * An attempt records the hash of the effective binding it ran with:
 * role instructions + runtime/model/effort + policy + limits. Editing the
 * configuration afterwards produces a different hash, so history cannot be
 * rewritten by editing a file.
 */
import { createHash } from 'node:crypto';
import {
  type AgentConfigFile,
  type AgentSnapshot,
  type EffectiveAgentBinding,
  EFFECTIVE_BINDING_VERSION,
  limitsFromDefaults,
  validateEffectiveBinding,
} from './contracts.js';

/** Deterministic JSON: sorted object keys, no undefined members, no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const member = record[key];
      if (member !== undefined) out[key] = sortValue(member);
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError('canonical JSON cannot represent non-finite numbers');
  }
  return value;
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

export class UnknownAgentError extends Error {
  constructor(agentId: string, known: ReadonlyArray<string>) {
    super(`unknown agent "${agentId}"; configured agents: ${known.map((k) => `"${k}"`).join(', ')}`);
    this.name = 'UnknownAgentError';
  }
}

/** Resolve the effective binding for one agent: agent overrides win over runtime defaults. */
export function resolveAgentBinding(config: AgentConfigFile, agentId: string): EffectiveAgentBinding {
  const agent = config.agents.find((a) => a.id === agentId);
  if (agent === undefined) throw new UnknownAgentError(agentId, config.agents.map((a) => a.id));
  const runtime = config.runtimes[agent.runtime];
  if (runtime === undefined) {
    // Unreachable after validateAgentConfig; kept so this function is safe on unvalidated input.
    throw new Error(`agent "${agentId}" references unknown runtime "${agent.runtime}"`);
  }
  const model = agent.model ?? runtime.model;
  const effort = agent.effort ?? runtime.effort;
  const binding: EffectiveAgentBinding = {
    bindingVersion: EFFECTIVE_BINDING_VERSION,
    agentId: agent.id,
    instructions: agent.instructions,
    capabilities: [...agent.capabilities],
    policy: agent.policy,
    runtime: {
      id: agent.runtime,
      adapter: runtime.adapter,
      executable: runtime.executable,
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
    },
    limits: limitsFromDefaults(config.defaults),
  };
  return validateEffectiveBinding(binding);
}

/** Content-addressed snapshot of an effective binding. */
export function snapshotBinding(binding: EffectiveAgentBinding): AgentSnapshot {
  const canonical = canonicalJson(validateEffectiveBinding(binding));
  return { hash: sha256Hex(canonical), binding, canonicalJson: canonical };
}

export function computeAgentSnapshot(config: AgentConfigFile, agentId: string): AgentSnapshot {
  return snapshotBinding(resolveAgentBinding(config, agentId));
}

/** Re-hash persisted canonical JSON and compare with the recorded hash. */
export function verifySnapshot(canonical: string, expectedHash: string): boolean {
  return sha256Hex(canonical) === expectedHash;
}
