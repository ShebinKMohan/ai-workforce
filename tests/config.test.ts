import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAgentConfigFile } from '../src/core/config.js';
import { ContractValidationError, validateAgentConfig, validateTaskContract } from '../src/core/contracts.js';
import { computeAgentSnapshot, resolveAgentBinding, verifySnapshot } from '../src/core/snapshot.js';
import { tempDir } from './helpers/state.js';

const EXAMPLE_PATH = path.resolve('fixtures/agents/example.json');

function example(): Record<string, unknown> {
  return JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8')) as Record<string, unknown>;
}

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).reverse()) out[key] = reverseKeys((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

function issuesOf(input: unknown): string[] {
  try {
    validateAgentConfig(input);
  } catch (error) {
    expect(error).toBeInstanceOf(ContractValidationError);
    return (error as ContractValidationError).issues.map((issue) => `${issue.path}: ${issue.message}`);
  }
  throw new Error('expected validation to fail');
}

describe('agent configuration validation', () => {
  it('accepts the documented example', () => {
    const config = validateAgentConfig(example());
    expect(config.agents.map((a) => a.id)).toEqual(['engineer', 'architect', 'reviewer']);
    expect(config.defaults.maxActiveTurns).toBe(2);
  });

  it('rejects unknown fields anywhere with the field path', () => {
    const doc = example();
    (doc['runtimes'] as Record<string, Record<string, unknown>>)['codex-local']!['sandbox'] = 'full';
    (doc['agents'] as Record<string, unknown>[])[0]!['temperature'] = 0.2;
    doc['extra'] = true;
    const issues = issuesOf(doc);
    expect(issues).toContainEqual(expect.stringMatching(/^runtimes\.codex-local: unknown field "sandbox"/));
    expect(issues).toContainEqual(expect.stringMatching(/^agents\[0\]: unknown field "temperature"/));
    expect(issues).toContainEqual(expect.stringMatching(/^\(root\): unknown field "extra"/));
  });

  it('rejects unknown runtime references naming the known runtimes', () => {
    const doc = example();
    (doc['agents'] as Record<string, unknown>[])[1]!['runtime'] = 'gemini-local';
    const issues = issuesOf(doc);
    expect(issues).toContainEqual('agents[1].runtime: agent "architect" references unknown runtime "gemini-local"; known runtimes: "codex-local", "claude-local"');
  });

  it('rejects unknown agent references in defaults', () => {
    const doc = example();
    (doc['defaults'] as Record<string, unknown>)['reviewerAgent'] = 'qa';
    const issues = issuesOf(doc);
    expect(issues).toContainEqual('defaults.reviewerAgent: references unknown agent "qa"; known agents: "engineer", "architect", "reviewer"');
  });

  it('rejects duplicate agent ids', () => {
    const doc = example();
    (doc['agents'] as Record<string, unknown>[])[2]!['id'] = 'engineer';
    const issues = issuesOf(doc);
    expect(issues).toContainEqual('agents[2].id: duplicate agent id "engineer" (first defined at agents[0]); agent ids must be unique');
  });

  it('rejects unsupported adapters, policies and schema versions', () => {
    const doc = example();
    doc['schemaVersion'] = 2;
    (doc['runtimes'] as Record<string, Record<string, unknown>>)['codex-local']!['adapter'] = 'gemini';
    (doc['agents'] as Record<string, unknown>[])[0]!['policy'] = 'yolo';
    const issues = issuesOf(doc);
    expect(issues.some((i) => i.startsWith('schemaVersion:'))).toBe(true);
    expect(issues.some((i) => i.startsWith('runtimes.codex-local.adapter:'))).toBe(true);
    expect(issues.some((i) => i.startsWith('agents[0].policy:'))).toBe(true);
  });

  it('rejects out-of-range limits and missing required fields', () => {
    const doc = example();
    const defaults = doc['defaults'] as Record<string, unknown>;
    defaults['maxActiveTurns'] = 0;
    delete defaults['runTimeoutMinutes'];
    const issues = issuesOf(doc);
    expect(issues.some((i) => i.startsWith('defaults.maxActiveTurns:'))).toBe(true);
    expect(issues).toContainEqual(expect.stringMatching(/^defaults\.runTimeoutMinutes: missing required field/));
  });

  it('reports unreadable and malformed files with the file path', () => {
    const dir = tempDir();
    expect(() => loadAgentConfigFile(path.join(dir, 'missing.json'))).toThrow(/cannot read file \(file not found\)/);
    const malformed = path.join(dir, 'malformed.json');
    writeFileSync(malformed, '{ "schemaVersion": 1, }');
    expect(() => loadAgentConfigFile(malformed)).toThrow(/not valid JSON/);
  });
});

describe('effective binding and immutable snapshot', () => {
  it('lets agent overrides win over runtime defaults and records the binding hash', () => {
    const doc = example();
    (doc['runtimes'] as Record<string, Record<string, unknown>>)['codex-local']!['model'] = 'runtime-model';
    (doc['runtimes'] as Record<string, Record<string, unknown>>)['codex-local']!['effort'] = 'medium';
    (doc['agents'] as Record<string, unknown>[])[1]!['model'] = 'agent-model';
    const config = validateAgentConfig(doc);
    const binding = resolveAgentBinding(config, 'architect');
    expect(binding.runtime).toEqual({ id: 'codex-local', adapter: 'codex', executable: 'codex', model: 'agent-model', effort: 'medium' });
    const snapshot = computeAgentSnapshot(config, 'architect');
    expect(snapshot.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(verifySnapshot(snapshot.canonicalJson, snapshot.hash)).toBe(true);
  });

  it('changes the hash when the role prompt or runtime binding changes, not when key order changes', () => {
    const base = validateAgentConfig(example());
    const original = computeAgentSnapshot(base, 'engineer');

    const reordered = validateAgentConfig(reverseKeys(example()));
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(base));
    expect(computeAgentSnapshot(reordered, 'engineer').hash).toBe(original.hash);

    const edited = example();
    (edited['agents'] as Record<string, unknown>[])[0]!['instructions'] = 'Different instructions.';
    expect(computeAgentSnapshot(validateAgentConfig(edited), 'engineer').hash).not.toBe(original.hash);

    const rebound = example();
    (rebound['agents'] as Record<string, unknown>[])[0]!['runtime'] = 'codex-local';
    expect(computeAgentSnapshot(validateAgentConfig(rebound), 'engineer').hash).not.toBe(original.hash);
  });
});

describe('task contract validation', () => {
  it('applies defaults and rejects duplicate criterion ids and unknown fields', () => {
    const contract = validateTaskContract({ contractVersion: 1, objective: 'x', scope: {}, acceptanceCriteria: [{ id: 'a', description: 'A' }] });
    expect(contract.dependencies).toEqual([]);
    expect(contract.scope.allowedPaths).toEqual([]);
    expect(() =>
      validateTaskContract({ contractVersion: 1, objective: 'x', scope: {}, acceptanceCriteria: [{ id: 'a', description: 'A' }, { id: 'a', description: 'B' }] }),
    ).toThrow(/duplicate acceptance criterion id "a"/);
    expect(() => validateTaskContract({ contractVersion: 1, objective: 'x', scope: {}, acceptanceCriteria: [{ id: 'a', description: 'A', check: { command: 'npm', shell: true } }] })).toThrow(
      /acceptanceCriteria\[0\]\.check: unknown field "shell"/,
    );
  });
});
