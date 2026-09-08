import { describe, expect, it } from 'vitest';
import { renderMessageBody } from '../../src/core/run-direct.js';

/**
 * A message body is stored parsed, so the delivery path used to interpolate an
 * object and every peer message reached its recipient as the literal string
 * "[object Object]". The channel worked; the payload did not survive the last
 * hop, which is why AT05 could never pass.
 */
describe('coordination message rendering', () => {
  it('never renders a body as [object Object]', () => {
    for (const body of [
      { text: 'the codename is heron' },
      { subject: 'codename', text: 'heron' },
      { value: 42 },
      { items: [1, 2, 3] },
      { a: 'one', b: 'two' },
      {},
    ]) {
      expect(renderMessageBody(body)).not.toContain('[object Object]');
    }
  });

  it('renders a string body as the text the sender wrote', () => {
    // send_message normalizes a string body to { text }.
    expect(renderMessageBody({ text: 'the codename is heron' })).toBe('the codename is heron');
  });

  it('keeps the subject beside the text', () => {
    expect(renderMessageBody({ subject: 'codename', text: 'heron' })).toBe('codename: heron');
  });

  it('serializes a structured body instead of stringifying the object', () => {
    const rendered = renderMessageBody({ interface: 'paginate(items, page, size)', owner: 't1' });
    expect(rendered).toContain('paginate(items, page, size)');
    expect(rendered).toContain('t1');
  });
});
