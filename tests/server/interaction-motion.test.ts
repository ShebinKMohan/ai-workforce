import { afterEach, describe, expect, it, vi } from 'vitest';

const animate = vi.hoisted(() => vi.fn());
vi.mock('../../web/headquarters/src/headquarters/assets/motion.js', () => ({ animate }));
const source = '../../web/headquarters/src/headquarters/interaction-motion.js';
const management = '../../web/headquarters/src/headquarters/management.js';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); animate.mockReset(); });

async function setup(reduce = false) {
  const preference = { matches: reduce, addEventListener: vi.fn() };
  vi.stubGlobal('matchMedia', () => preference);
  const motion = await import(source);
  const listeners: Record<string, (event: unknown) => void> = {};
  const root = { addEventListener: (name: string, listener: (event: unknown) => void) => { listeners[name] = listener; } };
  const dispose = motion.installInteractionMotion(root);
  const cancel = vi.fn();
  animate.mockReturnValue({ cancel });
  return { motion, preference, listeners, dispose, cancel, element: { animate() {} } };
}

describe('accessible interaction motion', () => {
  it('keeps reduced-motion interactions immediate', async () => {
    const { motion, element, dispose } = await setup(true);
    motion.revealPanel(element); motion.revealTask(element); motion.acknowledgeStatus(element);
    expect(motion.canAnimate()).toBe(false);
    expect(animate).not.toHaveBeenCalled(); dispose();
  });
  it('animates pointer feedback but never delays keyboard navigation', async () => {
    const { motion, listeners, element, dispose } = await setup();
    motion.revealPanel(element);
    expect(animate).toHaveBeenCalledTimes(1);
    listeners.keydown!({}); motion.revealPanel(element); motion.revealTask(element);
    expect(animate).toHaveBeenCalledTimes(1);
    listeners.pointerdown!({ target: { closest: () => null } });
    motion.acknowledgeStatus(element);
    expect(animate).toHaveBeenCalledTimes(2); dispose();
  });
  it('cancels in-flight movement as soon as reduced motion is enabled', async () => {
    const { motion, preference, element, cancel, dispose } = await setup();
    motion.revealTask(element);
    preference.matches = true;
    preference.addEventListener.mock.calls[0]![1]();
    expect(cancel).toHaveBeenCalledOnce();
    motion.revealPanel(element);
    expect(animate).toHaveBeenCalledOnce(); dispose();
  });
});

describe('automatic new-agent runtime choice', () => {
  it('uses the ready Control Center runtime even if another installation is listed first', async () => {
    const { preferredRuntime } = await import(management);
    const organization = { runtimes: [['claude', 'Claude'], ['codex', 'Codex']], orchestrator: { runtime: 'codex' }, runtimeReport: (id: string) => ({ usable: id === 'codex' }) };
    expect(preferredRuntime(organization)).toBe('codex');
    expect(preferredRuntime({ ...organization, orchestrator: { runtime: 'claude' } })).toBe('codex');
    expect(preferredRuntime({ ...organization, runtimeReport: () => null })).toBe('codex');
    expect(preferredRuntime({ runtimes: [] })).toBe('');
  });
});
