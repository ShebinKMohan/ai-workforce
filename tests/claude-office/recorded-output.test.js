import { describe, expect, it } from 'vitest';
import { renderRecordedMarkdown, renderRecordedOutput } from '../../web/claude-office/src/recorded-output.js';

describe('recorded runtime output formatting', () => {
  it('renders code, paragraphs and inline references without interpreting source code as HTML', () => {
    const html = renderRecordedMarkdown('Updated `applyDiscount`.\n\n```js\nconst html = "<script>alert(1)</script>";\n```\n\nVerified the result.');
    expect(html).toContain('<p>Updated <code>applyDiscount</code>.</p>');
    expect(html).toContain('<pre><code>const html = &quot;&lt;script&gt;alert(1)&lt;/script&gt;&quot;;</code></pre>');
    expect(html).toContain('<p>Verified the result.</p>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('```');
  });

  it('compacts absolute file links and inline file paths while retaining the complete location as a title', () => {
    const path = '/Users/person/.workforce/workspaces/long-run-id/candidate/src/cart.js:12';
    const html = renderRecordedMarkdown(`Changed [${path}](${path}) and \`${path}\`.`);
    expect(html).toContain(`title="${path}">cart.js:12</code>`);
    expect(html).not.toContain('href=');
    expect(html.replace(/title="[^"]*"/g, '')).not.toContain('/Users/');
    const spaces = renderRecordedMarkdown('[cart.js](</Users/person/My Project/src/cart.js>)');
    expect(spaces).toContain('title="/Users/person/My Project/src/cart.js">cart.js</code>');
  });

  it('allows only explicit HTTP and HTTPS links, never script, data, protocol-relative or file navigation', () => {
    const html = renderRecordedMarkdown('[Docs](https://example.com/path?a=1&b=2) [HTTP](http://example.com) [Bad](javascript:alert(1)) [Data](data:text/html,evil) [External](//example.com) [File](file:///tmp/test.txt)');
    expect(html).toContain('href="https://example.com/path?a=1&amp;b=2"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('href="http://example.com/"');
    expect((html.match(/href=/g) || [])).toHaveLength(2);
    expect(html).not.toMatch(/href="(?:javascript|data|file|\/\/)/);
  });

  it('escapes raw HTML, hostile link labels, fence labels and local-path attribute delimiters', () => {
    const html = renderRecordedOutput('<img src=x onerror=alert(1)>\n[<svg onload=alert(1)>](https://example.com)\n[file](/tmp/x"onmouseover="bad)\n```<img src=x>\n<script>bad()</script>\n```');
    expect(html).not.toMatch(/<(?:img|svg|script)\b/);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('title="/tmp/x&quot;onmouseover=&quot;bad"');
    expect(html).toContain('<summary>Original output</summary>');
    expect(html).not.toMatch(/\sonmouseover="bad"/);
  });

  it('keeps unfinished streamed code fences safe and bounds large transcripts with access to original text', () => {
    expect(renderRecordedMarkdown('```html\n<img src=x>')).toContain('<pre><code>&lt;img src=x&gt;</code></pre>');
    const text = `First line\n${'x'.repeat(100_000)}`;
    const html = renderRecordedOutput(text);
    expect(html).toContain('Preview shortened');
    expect(html).toContain('Original output · first 64,000 characters');
    expect(html).toContain('Open task evidence for the complete recorded output.');
    expect(html.length).toBeLessThan(80_000);
  });
});
