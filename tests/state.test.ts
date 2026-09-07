import { describe, expect, it } from 'vitest';
import { ATTEMPT_TRANSITIONS, IllegalTransitionError, RUN_TRANSITIONS, TASK_TRANSITIONS, assertTransition, canTransition, isTerminal, validateWaitReason } from '../src/core/state.js';
import { AttemptStateSchema, RunStateSchema, TaskStateSchema } from '../src/core/contracts.js';

describe('lifecycle transition validator', () => {
  it('covers every declared state exactly once per table', () => {
    expect(Object.keys(TASK_TRANSITIONS).sort()).toEqual([...TaskStateSchema.options].sort());
    expect(Object.keys(RUN_TRANSITIONS).sort()).toEqual([...RunStateSchema.options].sort());
    expect(Object.keys(ATTEMPT_TRANSITIONS).sort()).toEqual([...AttemptStateSchema.options].sort());
  });

  it('accepts the nominal task path pending -> ready -> running -> validating -> accepted', () => {
    expect(assertTransition('task', 'pending', 'ready')).toBe('ready');
    expect(assertTransition('task', 'ready', 'running')).toBe('running');
    expect(assertTransition('task', 'running', 'validating')).toBe('validating');
    expect(assertTransition('task', 'validating', 'accepted')).toBe('accepted');
  });

  it('never lets a running task become accepted without validation (runtime "done" is not acceptance)', () => {
    expect(canTransition('task', 'running', 'accepted')).toBe(false);
    expect(canTransition('task', 'ready', 'accepted')).toBe(false);
    expect(canTransition('task', 'pending', 'accepted')).toBe(false);
    expect(() => assertTransition('task', 'running', 'accepted')).toThrow(IllegalTransitionError);
    expect(() => assertTransition('task', 'running', 'accepted')).toThrow(/allowed from running: validating, waiting, failed, cancelled, superseded/);
  });

  it('treats superseded and ready_for_review as terminal and rejects same-state transitions', () => {
    expect(isTerminal('task', 'superseded')).toBe(true);
    expect(isTerminal('run', 'ready_for_review')).toBe(true);
    expect(isTerminal('attempt', 'superseded')).toBe(true);
    expect(canTransition('task', 'superseded', 'ready')).toBe(false);
    expect(canTransition('task', 'running', 'running')).toBe(false);
    expect(canTransition('run', 'failed', 'running')).toBe(false);
  });

  it('allows explicit resume paths only from interrupted or cancelled states', () => {
    expect(canTransition('run', 'interrupted', 'running')).toBe(true);
    expect(canTransition('run', 'cancelled', 'running')).toBe(true);
    expect(canTransition('run', 'ready_for_review', 'running')).toBe(false);
    expect(canTransition('attempt', 'interrupted', 'running')).toBe(true);
    expect(canTransition('attempt', 'completed', 'running')).toBe(false);
    expect(canTransition('task', 'cancelled', 'ready')).toBe(true);
    expect(canTransition('task', 'accepted', 'running')).toBe(false);
  });

  it('requires a wait reason exactly when waiting', () => {
    expect(() => validateWaitReason('waiting', null)).toThrow(/explicit wait reason/);
    expect(() => validateWaitReason('waiting', 'peer')).not.toThrow();
    expect(() => validateWaitReason('running', 'peer')).toThrow(/only valid in state waiting/);
  });
});
