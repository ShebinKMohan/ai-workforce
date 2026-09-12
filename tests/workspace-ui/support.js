/**
 * Shared helpers for the workspace UI tests. Every fixture under ./fixtures is
 * a document a real `workforce serve` returned for real runs on the
 * deterministic fake runtime (see the header of each test), with temp paths
 * replaced by stable ones. Nothing here is written by hand.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { indexWorkspace, needsYouList, setupModel, taskEntries } from '../../web/workspace/src/model.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

export function fixture(name) {
  return JSON.parse(readFileSync(`${FIXTURES}${name}`, 'utf8'));
}

export const clone = (value) => structuredClone(value);

export function uiState(overrides = {}) {
  return { expanded: new Set(), hidden: new Set(), drafts: new Map(), projectForms: new Map(), taskFilter: 'all', ...overrides };
}

export function contextFor(workspaceDoc, runsDoc, requestsDoc, { ui = uiState(), route = { name: 'home' }, now = Date.parse('2026-09-12T12:00:00Z') } = {}) {
  const ws = indexWorkspace(workspaceDoc);
  const entries = taskEntries(ws, runsDoc, requestsDoc);
  return { ws, entries, setup: setupModel(ws, requestsDoc, runsDoc), needs: needsYouList(ws, entries, ui.hidden), runsDoc, requestsDoc, ui, route, now };
}

/** The HTML with every `data-record` element (and everything inside it) removed. */
export function withoutRecords(html) {
  let out = html;
  for (;;) {
    const open = /<([a-z0-9]+)\b[^>]*\sdata-record\b[^>]*>/i.exec(out);
    if (!open) return out;
    const tag = open[1].toLowerCase();
    const pattern = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
    pattern.lastIndex = open.index + open[0].length;
    let depth = 1;
    let end = out.length;
    for (let match = pattern.exec(out); match; match = pattern.exec(out)) {
      if (match[1]) {
        depth -= 1;
        if (depth === 0) {
          end = match.index + match[0].length;
          break;
        }
      } else if (!match[0].endsWith('/>')) depth += 1;
    }
    out = out.slice(0, open.index) + out.slice(end);
  }
}

/** Visible text outside records: tags removed, entities decoded. */
export function visibleText(html) {
  return withoutRecords(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
