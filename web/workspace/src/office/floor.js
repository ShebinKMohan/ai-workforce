/**
 * The office floor as HTML: department tiles tinted with their colour, a desk
 * drawing per agent (decoration, aria-hidden), and a nameplate link with the
 * agent's name, a status word from records and its project chips. No pan, no
 * zoom, no animation; tiles wrap and stack on narrow screens.
 */
import { esc, keyed } from '../render.js';
import { deskSvg, tint } from './desk.js';
import { TONE_ICON } from '../words.js';

function nameplate(desk) {
  const chips = desk.chips.length
    ? `<span class="chips">${desk.chips.map((chip) => `<span class="chip${chip.active ? ' chip-active' : ''}" title="${esc(chip.name)}">${esc(chip.monogram)}</span>`).join('')}</span>`
    : '';
  const toneIcon = desk.tone !== 'neutral' ? `<span class="tone-icon" aria-hidden="true">${TONE_ICON[desk.tone] ?? ''}</span>` : '';
  return `<a class="nameplate" href="${esc(desk.href)}" aria-label="${esc(desk.ariaLabel)}">
    <span class="nameplate-name">${esc(desk.name)}</span>
    <span class="nameplate-status tone-${esc(desk.tone)}">${toneIcon}${esc(desk.statusWord)}</span>
    ${desk.roleLine ? `<span class="nameplate-role">${esc(desk.roleLine)}</span>` : ''}${chips}
  </a>`;
}

export function floorHtml(model) {
  const tiles = model.departments.map((department) => {
    const style = `--tile-fill:${tint(department.colorHex, 0.86)};--tile-border:${tint(department.colorHex, 0.7)};--tile-dot:${department.colorHex}`;
    const desks = department.desks.map((desk) => keyed('li', `desk:${desk.agentId}`, `class="desk desk-${esc(desk.role)}"`, `${deskSvg(desk.agentId)}${nameplate(desk)}`)).join('');
    const inner = `<header class="tile-head"><span class="dot" aria-hidden="true"></span><h3><a href="${esc(department.href)}">${esc(department.label)}</a></h3><p class="tile-counts">${esc(department.counts)}</p></header>
      ${department.desks.length ? `<ul class="desks" role="list">${desks}</ul>` : '<p class="muted">No one here yet.</p>'}`;
    return keyed('li', `tile:${department.id}`, `class="tile" style="${esc(style)}"`, inner);
  });
  const create = model.createTile.enabled
    ? `<a class="tile-create-link" href="${esc(model.createTile.href)}">${model.empty ? '<strong>No departments yet</strong><span>Create a department</span>' : '<span>+ Create a department</span>'}</a>`
    : `<div class="tile-create-disabled" aria-disabled="true"><strong>No departments yet</strong><span>Create a department · ${esc(model.createTile.note ?? '')}</span></div>`;
  tiles.push(keyed('li', 'tile:create', 'class="tile tile-create"', create));
  return `<ul class="floor" role="list">${tiles.join('')}</ul>`;
}
