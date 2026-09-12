/**
 * One desk, drawn as an SVG string.
 *
 * `tint`, `agentAppearance` and `drawDesk` are copied from
 * web/office/src/extra-desks.js (lines 19-74), with the DOM calls replaced by
 * string output so the office floor renders in Node as well as in a browser.
 * The shapes, colours and the per-agent appearance rule are unchanged: the same
 * agent id always draws the same figure. They are copied, not imported, because
 * `workforce serve` serves only web/workspace.
 *
 * A desk is decoration: it is always `aria-hidden`, and it says nothing about
 * what an agent is doing. The nameplate beside it carries the status word.
 */

/** `hex` lightened towards white by `white` (0..1). An invalid hex falls back to the neutral sage the office used. */
export function tint(hex, white = 0) {
  const safe = /^#[0-9a-f]{6}$/i.test(hex || '') ? hex : '#819b92';
  const channels = [1, 3, 5].map((index) => Math.round(parseInt(safe.slice(index, index + 2), 16) * (1 - white) + 255 * white));
  return `rgb(${channels.join(' ')})`;
}

/** A stable figure per agent id. */
export function agentAppearance(id) {
  const seed = Array.from(String(id)).reduce((value, character) => value + character.charCodeAt(0), 0);
  return {
    shirt: ['#4f7685', '#647d68', '#94706e', '#766d94', '#b58c59', '#567d79'][seed % 6],
    skin: ['#bc8b67', '#d7ad88', '#946b50', '#e2bb97'][seed % 4],
    hair: ['#3d352f', '#4c3d30', '#272e30'][seed % 3],
  };
}

const escapeAttribute = (value) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function el(tag, attributes) {
  const text = Object.entries(attributes)
    .map(([name, value]) => `${name}="${escapeAttribute(value)}"`)
    .join(' ');
  return `<${tag} ${text}/>`;
}

/** The desk group for `employee` ({ id, x, y }), as SVG markup. */
export function drawDesk(employee) {
  const { shirt, skin, hair } = agentAppearance(employee.id);
  const parts = [
    el('ellipse', { cx: 9, cy: 91, rx: 72, ry: 17, fill: '#48565c', opacity: '.065' }),
    el('path', { d: 'M-67 14v60l6 3V15M60 24v60l6 3V21M3 52v45l6 3V52', fill: '#a78e6d' }),
    el('path', { d: 'M-73 6-9-29 72 18 8 53Z', fill: '#e6cfaa', stroke: '#bea982', 'stroke-width': '1' }),
    el('path', { d: 'M-73 6v7L8 60v-7ZM8 53v7l64-35v-7Z', fill: '#c6ab81' }),
    el('path', { d: 'M-68 6-9-26 66 18 8 49Z', fill: '#ecd9b9', opacity: '.75' }),
    el('path', { d: 'm-24 6 19-10 13 7-19 11Z', fill: '#7b8789' }),
    el('path', { d: 'M-14-19v25l6 3v-28Z', fill: '#68777b' }),
    el('path', { d: 'm-51-39 40-23 5 3-40 24Z', fill: '#647980' }),
    el('path', { d: 'M-51-39-11-62v47L-51 8Z', fill: '#40535d' }),
    el('path', { d: 'M-47-36-15-54v35L-47 0Z', fill: '#dceef1' }),
    el('path', { d: 'm-44-31 25-14m-25 20 16-9m-16 15 25-14m-25 20 20-11', fill: 'none', stroke: '#80b3ca', 'stroke-width': '2.3' }),
    el('path', { d: 'm-20 14 22-12 24 14L4 28Z', fill: '#f6f4ec', stroke: '#b4b6ac', 'stroke-width': '.8' }),
    el('path', { d: 'm-13 14 13-7m-8 11 13-7m-7 11 13-7', stroke: '#acb4b0', 'stroke-width': '1.3' }),
    el('ellipse', { cx: 38, cy: 22, rx: 5, ry: 3.5, fill: '#faf8f0', transform: 'rotate(28 38 22)' }),
    el('path', { d: 'M24 59v24m0 0-19 5m19-5 21 7m-21-7 3 12', stroke: '#526164', 'stroke-width': '3.5', 'stroke-linecap': 'round', fill: 'none' }),
    el('circle', { cx: 5, cy: 89, r: 3, fill: '#405055' }),
    el('circle', { cx: 45, cy: 91, r: 3, fill: '#405055' }),
    el('circle', { cx: 27, cy: 96, r: 3, fill: '#405055' }),
    el('path', { d: 'M10 49 3 70-10 75m33-23-2 22-12 8', stroke: '#3c4b53', 'stroke-width': '8', 'stroke-linecap': 'round', fill: 'none' }),
    el('path', { d: 'm-12 75 9 2m8 6 10 1', stroke: '#313b40', 'stroke-width': '5', 'stroke-linecap': 'round' }),
    el('ellipse', { cx: 22, cy: 53, rx: 19, ry: 10, fill: '#5f7174' }),
    el('path', { d: 'M11 5C3 12 0 29 4 44l31 5c4-16 0-29-8-39Z', fill: shirt }),
    el('path', { d: 'M6 14-1 29-11 22m38-4 8 15-5 2', stroke: shirt, 'stroke-width': '8', 'stroke-linecap': 'round', fill: 'none' }),
    el('path', { d: 'm-11 22-5-3m47 16 3-6', stroke: skin, 'stroke-width': '5', 'stroke-linecap': 'round' }),
    el('path', { d: 'M15-3v12l8 2V-3Z', fill: skin }),
    el('ellipse', { cx: 18, cy: -8, rx: 10, ry: 12, fill: skin, transform: 'rotate(-12 18 -8)' }),
    el('path', { d: 'M8-7C3-26 29-27 29-11l-3 8-5-2-1-10-10 1Z', fill: hair }),
    el('path', { d: 'M8 28c8-5 21-3 27 4v23c-9 5-18 3-26-1Z', fill: '#687e80', stroke: '#51696d', 'stroke-width': '1.5' }),
    el('path', { d: 'M13 33c6-2 14-1 17 1v14c-5 2-11 1-16-1Z', fill: '#7e9190', opacity: '.55' }),
  ];
  return `<g transform="translate(${employee.x - 18} ${employee.y + 7})">${parts.join('')}</g>`;
}

/**
 * The inline SVG for one agent's desk. `drawDesk` translates by x-18, y+7, so
 * x 94, y 57 places the drawing inside the 160 x 176 box.
 */
export function deskSvg(agentId) {
  return `<svg class="desk-art" viewBox="0 0 160 176" width="96" height="106" aria-hidden="true" focusable="false">${drawDesk({ id: agentId, x: 94, y: 57 })}</svg>`;
}
