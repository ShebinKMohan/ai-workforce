import { afterEach, describe, expect, it, vi } from 'vitest';
const modulePath = '../../web/headquarters/src/headquarters/avatar-animation.js';
const catalogPath = '../../web/headquarters/src/headquarters/avatar-catalog.js';
const { renderAnimatedAvatar, startAvatarAnimations } = await import(modulePath);
const { portraitById } = await import(catalogPath);

afterEach(() => vi.useRealTimers());

function environment() {
  const handlers = new Map<string, () => void>();
  const preference: any = { matches: false, addEventListener: (_: string, cb: () => void) => { preference.change = cb; }, removeEventListener: vi.fn() };
  const nodes: any[] = [];
  let intersection: any;
  let mutation: any;
  const doc: any = {
    hidden: false,
    querySelectorAll: vi.fn(() => nodes),
    contains: (node: any) => nodes.includes(node),
    addEventListener: (name: string, cb: () => void) => handlers.set(name, cb),
    removeEventListener: (name: string) => handlers.delete(name),
    defaultView: {
      matchMedia: () => preference,
      setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
      clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
      IntersectionObserver: class { callback: any; observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn(); constructor(callback: any) { this.callback = callback; intersection = this; } },
      MutationObserver: class { callback: any; observe = vi.fn(); disconnect = vi.fn(); constructor(callback: any) { this.callback = callback; mutation = this; } },
    },
  };
  const add = (seed = '0') => { const frame = { style: { backgroundPosition: '' } }; const node = { isConnected: true, dataset: { avatarSeed: seed } as Record<string, string>, querySelector: () => frame }; nodes.push(node); return { node, frame }; };
  return { doc, preference, handlers, nodes, add, visible: (node: any, visible = true) => intersection.callback([{ target: node, isIntersecting: visible, intersectionRatio: visible ? 1 : 0 }]), mutate: (changes?: any[]) => mutation.callback(changes), observers: () => ({ intersection, mutation }) };
}

describe('rendered human expression animation', () => {
  it('uses a validated bundled sprite and keeps caller-provided strings out of HTML', () => {
    const html = renderAnimatedAvatar({ ...portraitById('portrait-02'), spriteSrc: "https://bad.test/'><script>bad()</script>" }, 70, '<script>identity</script>');
    expect(html).toContain('data-avatar-id="portrait-02"');
    expect(html).toContain('portrait-02.webp');
    expect(html).toContain('width:70px;height:70px');
    expect(html).not.toContain('script');
    expect(html).not.toContain('https://');
    expect(renderAnimatedAvatar({ id: '../unsafe' }, 70)).toBe('');
  });

  it('changes actual face frames, then resets and cancels timers offscreen or when the document hides', () => {
    vi.useFakeTimers();
    const env = environment(); const { node, frame } = env.add();
    const dispose = startAvatarAnimations(env.doc);
    expect(frame.style.backgroundPosition).toBe('0% 0%');
    expect(vi.getTimerCount()).toBe(0);
    env.visible(node);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(4800);
    expect(node.dataset.avatarFrame).toBe('1');
    expect(frame.style.backgroundPosition).toBe(`${100 / 3}% 0%`);
    vi.advanceTimersByTime(130);
    expect(node.dataset.avatarFrame).toBe('0');
    vi.advanceTimersByTime(1800);
    expect(node.dataset.avatarFrame).toBe('2');
    env.visible(node, false);
    expect(node.dataset.avatarFrame).toBe('0');
    expect(vi.getTimerCount()).toBe(0);
    env.visible(node);
    env.doc.hidden = true; env.handlers.get('visibilitychange')!();
    expect(vi.getTimerCount()).toBe(0);
    env.doc.hidden = false; env.handlers.get('visibilitychange')!();
    expect(vi.getTimerCount()).toBe(1);
    dispose(); expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps reduced-motion portraits still, responds to preference changes, and cleans up replaced portraits', () => {
    vi.useFakeTimers();
    const env = environment(); env.preference.matches = true;
    const first = env.add('3'); const dispose = startAvatarAnimations(env.doc);
    env.visible(first.node); vi.advanceTimersByTime(20_000);
    expect(first.node.dataset.avatarFrame).toBe('0');
    expect(vi.getTimerCount()).toBe(0);
    env.preference.matches = false; env.preference.change();
    expect(vi.getTimerCount()).toBe(1);
    first.node.isConnected = false; env.nodes.splice(0, 1); env.mutate();
    expect(vi.getTimerCount()).toBe(0);
    expect(env.observers().intersection.unobserve).toHaveBeenCalledWith(first.node);
    const next = env.add('12'); env.mutate(); env.visible(next.node);
    expect(vi.getTimerCount()).toBe(1);
    env.preference.matches = true; env.preference.change();
    expect(vi.getTimerCount()).toBe(0);
    expect(next.node.dataset.avatarFrame).toBe('0');
    dispose();
    expect(env.observers().intersection.disconnect).toHaveBeenCalled();
    expect(env.observers().mutation.disconnect).toHaveBeenCalled();
  });

  it('does not rescan avatars when the clock or duration text changes', () => {
    const env = environment(); env.add(); const dispose = startAvatarAnimations(env.doc);
    expect(env.doc.querySelectorAll).toHaveBeenCalledTimes(1);
    env.mutate([{addedNodes:[{nodeType:3}],removedNodes:[{nodeType:3}]}]);
    env.mutate([{addedNodes:[{nodeType:1,matches:()=>false,querySelector:()=>null}],removedNodes:[]}]);
    expect(env.doc.querySelectorAll).toHaveBeenCalledTimes(1);
    env.mutate([{addedNodes:[{nodeType:1,matches:()=>true}],removedNodes:[]}]);
    expect(env.doc.querySelectorAll).toHaveBeenCalledTimes(2);
    dispose();
  });

  it('falls back to still artwork when the visibility APIs are unavailable', () => {
    expect(() => startAvatarAnimations(undefined)()).not.toThrow();
    expect(() => startAvatarAnimations({ querySelectorAll: () => [] })()).not.toThrow();
  });
});
