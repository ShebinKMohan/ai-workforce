import { describe, expect, it } from 'vitest';
import { renderChatResponse, renderUserMessage } from '../../web/claude-office/src/chat-presentation.js';

// Parse only the static, quoted HTML produced by these renderers. Parent links
// let assertions distinguish visible answers/actions from closed trace content.
function parse(html) {
  const root = { tag: '#root', attrs: {}, children: [], parent: null };
  const stack = [root];
  const voidTags = new Set(['input', 'br', 'hr', 'img', 'meta', 'link', 'path']);
  for (const token of html.matchAll(/<\/?[a-z][a-z0-9-]*\b(?:[^"'<>]|"[^"]*"|'[^']*')*>|[^<]+/gi)) {
    const source = token[0];
    if (!source.startsWith('<')) { stack.at(-1).children.push({ text: source, parent: stack.at(-1) }); continue; }
    const tag = source.match(/^<\/?([a-z][a-z0-9-]*)/i)[1].toLowerCase();
    if (source.startsWith('</')) {
      const index = stack.findLastIndex(node => node.tag === tag);
      if (index > 0) stack.length = index;
      continue;
    }
    const attrs = {};
    const attributeText = source.slice(source.indexOf(tag) + tag.length).replace(/\/?\s*>$/, '');
    for (const match of attributeText.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[match[1]] = decode(match[2] ?? match[3] ?? match[4] ?? '');
    const node = { tag, attrs, children: [], parent: stack.at(-1) };
    stack.at(-1).children.push(node);
    if (!voidTags.has(tag) && !source.endsWith('/>')) stack.push(node);
  }
  return root;
}
const decode = text => String(text).replace(/&(amp|lt|gt|quot|#39);/g, (_, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[entity]));
const nodes = node => [node, ...(node.children || []).flatMap(nodes)];
const byClass = (root, name) => nodes(root).filter(node => node.attrs?.class?.split(/\s+/).includes(name));
const ancestor = (node, tag) => { for (let parent = node.parent; parent; parent = parent.parent) if (parent.tag === tag) return parent; return null; };
const textContent = node => node.text !== undefined ? decode(node.text) : node.children.map(textContent).join('');
const visibleText = node => {
  if (node.text !== undefined) return decode(node.text);
  const children = node.tag === 'details' && !Object.hasOwn(node.attrs, 'open') ? node.children.filter(child => child.tag === 'summary') : node.children;
  return children.map(visibleText).join('');
};
const occurrences = (text, value) => text.split(value).length - 1;
const flow = overrides => ({ directReply: false, label: 'Working', tone: 'active', reply: null, verified: false, legacyCheckResult: false, request: {}, ...overrides });

describe('a conversation answer with execution available on demand', () => {
  it('shows the main reply once outside the closed trace, with original source and reviewer inside', () => {
    const reply = 'The search bug is fixed.';
    const root = parse(renderChatResponse({ id: 'task-1', flow: flow({ label: 'Reviewed and verified', tone: 'verified', verified: true, reply: { text: reply, final: true } }), elapsedMs: 127_900, reviewer: 'Engineering head', traceHTML: '<p>Worker output and independent checks.</p>' }));
    const answers = byClass(root, 'control-center-reply');
    expect(answers).toHaveLength(1);
    expect(ancestor(answers[0], 'details')).toBeNull();
    expect(occurrences(visibleText(root), reply)).toBe(1);
    const trace = byClass(root, 'chat-trace')[0];
    expect(trace.attrs).not.toHaveProperty('open');
    expect(visibleText(trace)).toContain('Worked for 2m 7s');
    expect(visibleText(root)).not.toContain('Worker output');
    expect(visibleText(root)).not.toContain('Engineering head');
    const original = byClass(root, 'recorded-original')[0];
    expect(ancestor(original, 'details')).toBe(trace);
    expect(textContent(original)).toContain(reply);
    expect(original.attrs).not.toHaveProperty('open');
    expect(visibleText(root)).toContain('Reviewed and verified');
  });

  it('keeps worker-only output inside its trace and never invents a conversation answer', () => {
    const root = parse(renderChatResponse({ id: 'working', flow: flow(), traceHTML: '<p>Worker says the task is done.</p>', statusLine: 'The assigned worker is editing the files.' }));
    expect(byClass(root, 'control-center-reply')).toHaveLength(0);
    expect(visibleText(root)).toContain('The assigned worker is editing the files.');
    expect(visibleText(root)).not.toContain('Worker says the task is done.');
    expect(textContent(byClass(root, 'chat-trace')[0])).toContain('Worker says the task is done.');
    expect(visibleText(root)).not.toContain('Reviewed and verified');
  });

  it.each([
    { label: 'Task failed', tone: 'failed', reply: null, statusLine: 'The build failed.', action: 'Retry task' },
    { label: 'Runtime permission needed', tone: 'attention', reply: { text: 'Claude Code needs your permission.', final: false }, statusLine: 'Claude Code needs your permission.', action: 'Retry with permission' },
  ])('keeps $label and its actions visible without opening execution details', ({ label, tone, reply, statusLine, action }) => {
    const consentHTML = tone === 'attention' ? '<label class="runtime-consent"><input type="checkbox">Allow the selected runtime to write files</label>' : '';
    const root = parse(renderChatResponse({ id: 'blocked', flow: flow({ label, tone, reply }), statusLine, traceHTML: '<p>Detailed diagnostic.</p>', actionsHTML: `<button data-retry-task="blocked">${action}</button>`, consentHTML }));
    expect(visibleText(root)).toContain(statusLine);
    expect(occurrences(visibleText(root), statusLine)).toBe(1);
    const button = nodes(root).find(node => node.attrs?.['data-retry-task']);
    expect(ancestor(button, 'details')).toBeNull();
    expect(visibleText(root)).toContain(action);
    if (consentHTML) {
      const input = nodes(root).find(node => node.tag === 'input');
      expect(ancestor(input, 'details')).toBeNull();
      expect(visibleText(root)).toContain('Allow the selected runtime');
    }
  });

  it('keeps a refresh failure and stop overlay visible alongside the last recorded answer', () => {
    const root = parse(renderChatResponse({ id: 'stale', flow: flow({ reply: { text: 'The recorded result.', final: true }, verified: true }), refreshError: 'Connection lost', stopRequested: true }));
    const error = byClass(root, 'sidebar-error')[0];
    expect(error.attrs.role).toBe('status');
    expect(ancestor(error, 'details')).toBeNull();
    expect(visibleText(root)).toContain('Could not refresh the task: Connection lost. Showing the last received records.');
    expect(visibleText(root)).toContain('Stop requested. Waiting for the runtime to settle.');
    expect(visibleText(root)).toContain('The recorded result.');
  });

  it('keeps a runtime-stalled overlay visible outside the trace after a non-final routing acknowledgement', () => {
    const acknowledgement = 'Routed to Engineering. The department head will plan the work.';
    const overlay = 'Runtime stalled. Resume this task to continue.';
    const root = parse(renderChatResponse({
      id: 'routed-stalled',
      flow: flow({ label: 'Runtime stalled', tone: 'attention', reply: { text: acknowledgement, final: false } }),
      statusLine: acknowledgement,
      overlayLine: overlay,
      traceHTML: '<p>The last recorded execution event.</p>',
    }));
    const notice = byClass(root, 'chat-response-status').find(node => textContent(node) === overlay);
    expect(notice).toBeDefined();
    expect(ancestor(notice, 'details')).toBeNull();
    expect(occurrences(visibleText(root), overlay)).toBe(1);
    expect(occurrences(visibleText(root), acknowledgement)).toBe(1);
    expect(visibleText(root)).not.toContain('The last recorded execution event.');
    expect(byClass(root, 'chat-answer-verdict')).toHaveLength(0);
  });

  it('shows changed evidence beside a historical final reply without a fresh verified claim', () => {
    const root = parse(renderChatResponse({ id: 'changed', flow: flow({ tone: 'attention', label: 'Evidence needs review', reply: { text: 'The original delivery reply.', final: true } }), statusLine: 'Some saved check evidence has changed.' }));
    expect(visibleText(root)).toContain('The original delivery reply.');
    expect(visibleText(root)).toContain('Some saved check evidence has changed.');
    expect(byClass(root, 'chat-answer-verdict')).toHaveLength(0);
    expect(visibleText(root)).not.toContain('Worked for');
  });

  it('explains checks-only legacy history without fabricating a head-backed answer', () => {
    const root = parse(renderChatResponse({ id: 'legacy', flow: flow({ label: 'Checks verified', tone: 'neutral', verified: true, legacyCheckResult: true }), statusLine: 'Old generic status.', traceHTML: '<p>Legacy check records.</p>' }));
    expect(visibleText(root)).toContain('The checks passed for this earlier task. No department-head review or Control Center final reply was recorded.');
    expect(visibleText(root)).not.toContain('Old generic status.');
    expect(byClass(root, 'control-center-reply')).toHaveLength(0);
    expect(byClass(root, 'chat-answer-verdict')).toHaveLength(0);
  });

  it('renders a direct Control Center answer without a fake execution trace or evidence link', () => {
    const root = parse(renderChatResponse({ id: 'hello', flow: flow({ directReply: true, request: { controlReply: 'Hello. How can I help?' } }), traceHTML: '<p>This must not appear.</p>', statusLine: 'A duplicate explanation.' }));
    expect(byClass(root, 'chat-trace')).toHaveLength(0);
    expect(nodes(root).filter(node => node.attrs?.['data-open-task'])).toHaveLength(0);
    expect(visibleText(root)).toContain('Answered');
    expect(occurrences(visibleText(root), 'Hello. How can I help?')).toBe(1);
    expect(textContent(root)).not.toContain('This must not appear.');
    expect(textContent(root)).not.toContain('A duplicate explanation.');
    expect(byClass(root, 'chat-answer-verdict')).toHaveLength(0);
  });

  it('escapes untrusted reply, source, labels, metadata and attribute delimiters', () => {
    const malicious = '</details><script>alert(1)</script><img src=x onerror="bad">';
    const root = parse(renderChatResponse({ id: 'x" onclick="bad', flow: flow({ label: malicious, tone: 'active" onclick="bad', reply: { text: malicious, final: true } }), reviewer: malicious, refreshError: malicious, statusLine: malicious }));
    expect(nodes(root).some(node => ['script', 'img'].includes(node.tag))).toBe(false);
    expect(nodes(root).some(node => Object.keys(node.attrs || {}).some(key => /^on/i.test(key)))).toBe(false);
    expect(textContent(byClass(root, 'control-center-reply')[0])).toContain(malicious);
    const original = byClass(root, 'recorded-original')[0];
    expect(textContent(original)).toContain(malicious);
    expect(original.attrs['data-disclosure']).toBe('final-output:x" onclick="bad');
    expect(byClass(root, 'chat-trace')[0].attrs['data-trace-task']).toBe('x" onclick="bad');
  });

  it.each([
    { label: '12,000 characters', text: 'x'.repeat(12_000), shortened: false },
    { label: '12,001 characters', text: `${'x'.repeat(12_000)}Z`, shortened: true },
    { label: '600 lines', text: Array.from({ length: 600 }, (_, index) => `Line ${index}`).join('\n'), shortened: false },
    { label: '601 lines', text: Array.from({ length: 601 }, (_, index) => `Line ${index}`).join('\n'), shortened: true },
  ])('preserves direct answers at the $label preview boundary without a fake trace', ({ text, shortened }) => {
    const root = parse(renderChatResponse({ id: 'long-direct', flow: flow({ directReply: true, request: { controlReply: text } }) }));
    expect(byClass(root, 'chat-trace')).toHaveLength(0);
    expect(visibleText(root)).not.toContain('Expand the trace for the original output.');
    const sources = byClass(root, 'recorded-original');
    expect(sources).toHaveLength(shortened ? 1 : 0);
    expect(byClass(root, 'recorded-output-limit')).toHaveLength(shortened ? 1 : 0);
    if (shortened) {
      expect(visibleText(root)).toContain('Preview shortened. The original output is below.');
      expect(ancestor(sources[0], 'details')).toBeNull();
      expect(ancestor(sources[0], 'article')).toBe(byClass(root, 'control-center-reply')[0]);
      expect(sources[0].attrs).not.toHaveProperty('open');
      expect(textContent(sources[0].children.find(node => node.tag === 'pre'))).toBe(text);
    }
  });

  it('retains the original and preview warning for 650 CR-only lines below the character limit', () => {
    const text = Array.from({ length: 650 }, (_, index) => `Line ${index}`).join('\r');
    expect(text.length).toBeLessThan(12_000);
    const root = parse(renderChatResponse({ id: 'cr-direct', flow: flow({ directReply: true, request: { controlReply: text } }) }));
    expect(byClass(root, 'chat-trace')).toHaveLength(0);
    const warnings = byClass(root, 'recorded-output-limit');
    expect(warnings).toHaveLength(1);
    expect(textContent(warnings[0])).toBe('Preview shortened. The original output is below.');
    expect(visibleText(root)).toContain('Line 599');
    expect(visibleText(root)).not.toContain('Line 649');
    const sources = byClass(root, 'recorded-original');
    expect(sources).toHaveLength(1);
    expect(ancestor(sources[0], 'details')).toBeNull();
    expect(ancestor(sources[0], 'article')).toBe(byClass(root, 'control-center-reply')[0]);
    expect(textContent(sources[0].children.find(node => node.tag === 'pre'))).toBe(text);
    expect(visibleText(root)).toContain('Original output');
  });
});

describe('readable user messages without losing instructions', () => {
  it.each([
    `Preserve this exact task.\n${'Long requirement. '.repeat(60)}\nFinal requirement <script>not markup</script>.`,
    Array.from({ length: 12 }, (_, index) => `Requirement ${index + 1}`).join('\n'),
  ])('keeps the full long or multiline prompt in a closed disclosure', text => {
    const root = parse(renderUserMessage({ id: 'prompt" onclick="bad', text, project: '<img src=x>', at: 'Just now' }));
    const disclosure = byClass(root, 'chat-user-prompt')[0];
    expect(disclosure.attrs).not.toHaveProperty('open');
    expect(disclosure.attrs['data-disclosure']).toBe('prompt:prompt" onclick="bad');
    const full = disclosure.children.find(node => node.tag === 'p');
    expect(textContent(full)).toBe(text);
    expect(visibleText(root)).toContain('Show more');
    expect(nodes(root).some(node => ['script', 'img'].includes(node.tag))).toBe(false);
    expect(nodes(root).some(node => node.attrs?.onclick)).toBe(false);
    expect(textContent(byClass(root, 'chat-message-caption')[0])).toBe('<img src=x> · Just now');
  });

  it('keeps a short prompt visible without a disclosure', () => {
    const root = parse(renderUserMessage({ id: 'short', text: 'Fix the search bug.\nKeep the existing API.', project: 'Storefront' }));
    expect(byClass(root, 'chat-user-prompt')).toHaveLength(0);
    expect(visibleText(root)).toContain('Fix the search bug.\nKeep the existing API.');
  });
});
