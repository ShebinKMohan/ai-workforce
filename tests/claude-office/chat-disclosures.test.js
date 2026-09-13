import { describe, expect, it } from 'vitest';
import { createChatDisclosures } from '../../web/claude-office/src/chat-disclosures.js';

const disclosure = (key, open = false) => ({ dataset: { disclosure: key }, open });
const viewport = (...elements) => ({
  querySelectorAll(selector) {
    expect(selector).toBe('details[data-disclosure]');
    return elements;
  },
});

describe('chat disclosure choices across viewport rebuilds', () => {
  it('retains both an expanded trace and an explicitly closed trace after records change', () => {
    const state = createChatDisclosures();
    state.remember('chat', viewport(disclosure('execution:first', true), disclosure('execution:second', false)));
    const first = disclosure('execution:first');
    const second = disclosure('execution:second', true);
    state.restore('chat', viewport(second, first));
    expect(first.open).toBe(true);
    expect(second.open).toBe(false);

    // Closing an earlier expanded trace must overwrite its previous true.
    first.open = false;
    state.remember('chat', viewport(first, second));
    const nextFirst = disclosure('execution:first', true);
    state.restore('chat', viewport(nextFirst));
    expect(nextFirst.open).toBe(false);
  });

  it('keeps nested choices even while their parent trace is closed', () => {
    const state = createChatDisclosures();
    state.remember('chat', viewport(
      disclosure('execution:first', false),
      disclosure('runtime-output:first', true),
      disclosure('output:first:42', false),
    ));
    const parent = disclosure('execution:first', true);
    const nested = disclosure('runtime-output:first');
    const original = disclosure('output:first:42', true);
    state.restore('chat', viewport(parent, nested, original));
    expect([parent.open, nested.open, original.open]).toEqual([false, true, false]);
    parent.open = true;
    expect(nested.open).toBe(true);
  });

  it('restores each tab independently when the same task appears in both views', () => {
    const state = createChatDisclosures();
    state.remember('control|chat', viewport(disclosure('checks:first', true)));
    state.remember('control|tasks', viewport(disclosure('checks:first', false)));
    // A runtime tab has no task disclosures and cannot clear the chat choices.
    state.remember('control|connections', viewport());
    const chat = disclosure('checks:first');
    const activity = disclosure('checks:first', true);
    state.restore('control|chat', viewport(chat));
    state.restore('control|tasks', viewport(activity));
    expect(chat.open).toBe(true);
    expect(activity.open).toBe(false);
  });

  it('keeps choices when a task temporarily leaves the rendered history', () => {
    const state = createChatDisclosures();
    state.remember('chat', viewport(disclosure('execution:first', true)));
    state.remember('chat', viewport(disclosure('execution:second', false)));
    state.remember('chat', viewport());
    const returned = disclosure('execution:first');
    state.restore('chat', viewport(returned));
    expect(returned.open).toBe(true);
  });

  it('preserves defaults for new disclosures without copying another task or scope', () => {
    const state = createChatDisclosures();
    state.remember('chat', viewport(disclosure('execution:first', true)));
    const newClosed = disclosure('execution:second');
    const newOpen = disclosure('execution:third', true);
    const otherScope = disclosure('execution:first');
    state.restore('chat', viewport(newClosed, newOpen));
    state.restore('different-workspace|chat', viewport(otherScope));
    expect([newClosed.open, newOpen.open, otherScope.open]).toEqual([false, true, false]);
  });
});
