/**
 * A regression guard for the office view's honesty contract (FR084): the
 * prototype's invented data, canned replies and demo controls must not come
 * back into the served page, and nothing in it may write an agent
 * configuration or start work from anywhere but the explicit start control.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../web/office/', import.meta.url));
const read = (relative) => readFileSync(path.join(ROOT, relative), 'utf8');
const sources = readdirSync(path.join(ROOT, 'src')).filter((file) => /\.(js|css)$/.test(file));

describe('the served office carries no invented activity', () => {
  it('contains none of the prototype’s demo data, canned replies or sample labels', () => {
    const forbidden = ['demoCommunications', 'responseFor', 'progress: [', 'SAMPLE DATA', 'SAMPLE OUTPUT', 'LOCAL DEMO', 'no live AI calls', 'GPT-5.5', 'Qwen3', 'Claude Sonnet', 'Approved in demo', 'play-communication', 'Maya Chen', 'task-progress-track'];
    for (const file of [...sources.map((name) => `src/${name}`), 'index.html']) {
      const text = read(file);
      for (const phrase of forbidden) expect({ file, phrase, found: text.includes(phrase) }).toEqual({ file, phrase, found: false });
    }
  });

  it('no longer ships the browser-storage agent store or the separate mockup, and nothing saves agents', () => {
    expect(existsSync(path.join(ROOT, 'src', 'agent-store.js'))).toBe(false);
    expect(existsSync(path.join(ROOT, 'src', 'workspace'))).toBe(false);
    expect(read('src/agent-manager.js')).not.toMatch(/localStorage|fetch\(|api\./);
  });

  it('starts work from exactly one place: the Start run control, through POST /api/runs', () => {
    const callers = sources.filter((name) => name.endsWith('.js') && /api\.start\(/.test(read(`src/${name}`)));
    expect(callers).toEqual(['sidebar.js']);
    expect(read('src/api.js')).toContain("postJson('/api/runs', body)");
    // No timer anywhere draws a pulse or starts a request on its own behalf.
    expect(read('src/main.js')).not.toMatch(/setInterval\([^)]*communicate/);
  });

  it('does not describe the illustration’s drawn figures as employees, and draws a veil over every open desk', () => {
    const html = read('index.html');
    expect(html).not.toMatch(/stationary employees|employees at each/i);
    expect(html).toContain('id="seat-veils"');
    expect(read('src/main.js')).toMatch(/openSeatVeils\(store\.employees\)/);
    expect(read('src/styles.css')).toMatch(/\.open-seat-veil\s*\{/);
  });

  it('gives the panels what they need to refuse an overstatement: the lock, and each receipt’s compromise', () => {
    const sidebar = read('src/sidebar.js');
    // A bare `.map(checkView)` cannot know that a requirement marked the receipt compromised.
    expect(sidebar).not.toMatch(/\.map\(checkView\)/);
    expect(read('src/main.js')).toMatch(/deskState\(employee\.agentId, store\.runs, store\.lock\)/);
  });

  it('escapes what it renders: every innerHTML template in the panels goes through the escape helper', () => {
    for (const file of ['src/sidebar.js', 'src/agent-manager.js']) {
      const text = read(file);
      // Values interpolated from API documents are wrapped in esc()/escapeHTML(); a raw `${agent.` or `${run.` would be unescaped.
      expect({ file, raw: text.match(/\$\{(?:agent|run|report|task|status|check|requirement|event|item|outcome)\.[a-zA-Z]+\}/g) }).toEqual({ file, raw: null });
    }
  });
});
