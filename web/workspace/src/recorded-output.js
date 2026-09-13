/** A deliberately small Markdown subset for untrusted, recorded runtime output. No HTML or images. */
const esc = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const isLocal = value => /^(?:\/(?!\/)|~\/|[a-z]:[\\/]|file:\/\/)/i.test(value);
const basename = value => {
  let path = value.replace(/^file:\/\//i, '');
  try { path = decodeURIComponent(path); } catch { /* Invalid path escapes remain literal. */ }
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || path;
};
const fileLabel = (label, target) => isLocal(label) || label.length > 90 ? basename(target) : label;

function link(label, rawTarget) {
  const target = rawTarget.startsWith('<') && rawTarget.endsWith('>') ? rawTarget.slice(1, -1) : rawTarget;
  if (isLocal(target)) return `<code class="recorded-local-ref" title="${esc(target)}">${esc(fileLabel(label, target))}</code>`;
  try {
    const url = new URL(target);
    if (['http:', 'https:'].includes(url.protocol) && !/[\u0000-\u0020]/.test(target)) {
      return `<a href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
    }
  } catch { /* Relative references and unsupported schemes are inert labels. */ }
  return `<span class="recorded-link-label">${esc(label)}</span>`;
}

function inline(source) {
  const pattern = /(`+)(.*?)\1|\[([^\]\n]{1,300})\]\((<[^>\n]{1,4096}>|[^)\n]{1,4096})\)|\*\*([^*\n]{1,1000})\*\*/g;
  let html = '';
  let previous = 0;
  for (const match of source.matchAll(pattern)) {
    html += esc(source.slice(previous, match.index));
    if (match[1]) {
      const code = match[2];
      html += isLocal(code) ? `<code class="recorded-local-ref" title="${esc(code)}">${esc(basename(code))}</code>` : `<code>${esc(code)}</code>`;
    } else if (match[3]) html += link(match[3], match[4]);
    else html += `<strong>${esc(match[5])}</strong>`;
    previous = match.index + match[0].length;
  }
  return html + esc(source.slice(previous));
}

/** Bounded by characters and lines; malformed syntax remains readable escaped text. */
export function renderRecordedMarkdown(value, maxCharacters = 12_000) {
  const text = String(value ?? '').slice(0, Math.max(1, Math.min(Number(maxCharacters) || 12_000, 32_000)));
  const normalizedLines = text.replace(/\r\n?/g, '\n').split('\n');
  const lines = normalizedLines.slice(0, 600);
  const blocks = [];
  let paragraph = [];
  let list = [];
  let fence = null;
  let code = [];
  const flushParagraph = () => { if (paragraph.length) { blocks.push(`<p>${paragraph.map(inline).join('<br>')}</p>`); paragraph = []; } };
  const flushList = () => { if (list.length) { blocks.push(`<ul>${list.map(line => `<li>${inline(line)}</li>`).join('')}</ul>`); list = []; } };
  const flushCode = () => { blocks.push(`<div class="recorded-code">${fence.language ? `<span>${esc(fence.language.slice(0, 32))}</span>` : ''}<pre><code>${esc(code.join('\n'))}</code></pre></div>`); code = []; fence = null; };
  for (const line of lines) {
    if (fence) {
      const closing = line.trim();
      if (closing.length >= fence.length && [...closing].every(character => character === fence.character)) flushCode();
      else code.push(line);
      continue;
    }
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})([^`]*)$/);
    if (opening) { flushParagraph(); flushList(); fence = { character: opening[1][0], length: opening[1].length, language: opening[2].trim() }; continue; }
    if (!line.trim()) { flushParagraph(); flushList(); continue; }
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) { flushParagraph(); flushList(); blocks.push(`<h4>${inline(heading[1])}</h4>`); continue; }
    const bullet = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/);
    if (bullet) { flushParagraph(); list.push(bullet[1]); continue; }
    flushList(); paragraph.push(line);
  }
  flushParagraph(); flushList(); if (fence) flushCode();
  if (String(value ?? '').length > text.length || normalizedLines.length > 600) blocks.push('<p class="recorded-output-limit">Preview shortened. The original output is below.</p>');
  return blocks.join('');
}

/** Keep the source available without treating runtime prose as markup or task authority. */
export function renderRecordedSource(value) {
  const text = String(value ?? '');
  const source = text.slice(0, 64_000);
  return `<details class="recorded-original"><summary>Original output${text.length > source.length ? ' · first 64,000 characters' : ''}</summary><pre>${esc(source)}</pre>${text.length > source.length ? '<p>Open task evidence for the complete recorded output.</p>' : ''}</details>`;
}

export function renderRecordedOutput(value) {
  return `<div class="recorded-markdown">${renderRecordedMarkdown(value)}</div>${renderRecordedSource(value)}`;
}
