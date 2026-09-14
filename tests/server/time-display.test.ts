import { describe, expect, it } from 'vitest';
// @ts-expect-error Browser module has no TypeScript declaration.
import { durationSeconds, formatDuration, renderDuration, refreshTimeDisplays } from '../../web/headquarters/src/headquarters/time-display.js';

describe('recorded phase timing', () => {
  it('keeps completed duration fixed while an active phase advances', () => {
    expect(durationSeconds('2026-09-14T00:00:00Z', '2026-09-14T00:02:03Z', Date.parse('2026-09-15T00:00:00Z'))).toBe(123);
    expect(durationSeconds('2026-09-14T00:00:00Z', null, Date.parse('2026-09-14T00:02:10Z'))).toBe(130);
    expect(formatDuration(3723)).toBe('1h 02m 03s');
  });
  it('does not invent a completed duration or turn an invalid date into zero', () => {
    expect(durationSeconds(null, null)).toBeNull();
    expect(durationSeconds('invalid', 'invalid')).toBeNull();
    expect(durationSeconds(2000, 1000)).toBe(0);
    expect(renderDuration({ start:'2026-09-14T00:00:00Z', active:false })).toContain('data-duration-value>—');
    expect(renderDuration({ start:'" onmouseover="bad', label:'<unsafe>' })).not.toContain('<unsafe>');
  });
  it('ticks only elapsed text, leaves completed values intact, and skips unchanged writes', () => {
    const live = { textContent:'0s' }, settled = { textContent:'3s' };
    const nodes = [
      { dataset:{durationStart:'2026-09-14T00:00:00Z',durationEnd:'',durationActive:'true'}, querySelector:()=>live },
      { dataset:{durationStart:'2026-09-14T00:00:00Z',durationEnd:'2026-09-14T00:00:03Z',durationActive:'false'}, querySelector:()=>settled },
    ];
    const root = { querySelectorAll:(selector:string)=>selector==='[data-duration-start]'?nodes:[] };
    expect(refreshTimeDisplays(root,Date.parse('2026-09-14T00:01:05Z'))).toBe(1);
    expect(live.textContent).toBe('1m 05s'); expect(settled.textContent).toBe('3s');
    expect(refreshTimeDisplays(root,Date.parse('2026-09-14T00:01:05Z'))).toBe(0);
  });
});
