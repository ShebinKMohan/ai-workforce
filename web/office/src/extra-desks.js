// Extra desks extend the office without changing any of its original seats.
const SVG_NS = 'http://www.w3.org/2000/svg';
const ORIGINAL = { width: 1402, height: 1122 };
const WING = { x: 1450, width: 580, top: 66, column: 180, row: 190 };

function svg(tag, attributes = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  node.append(...children);
  return node;
}

function text(value, attributes) {
  const node = svg('text', attributes);
  node.textContent = value;
  return node;
}

function tint(hex, white = 0) {
  const safe = /^#[0-9a-f]{6}$/i.test(hex || '') ? hex : '#819b92';
  const channels = [1, 3, 5].map(index => Math.round(parseInt(safe.slice(index, index + 2), 16) * (1 - white) + 255 * white));
  return `rgb(${channels.join(' ')})`;
}

function agentAppearance(id) {
  const seed = Array.from(String(id)).reduce((value, character) => value + character.charCodeAt(0), 0);
  return {
    shirt: ['#4f7685', '#647d68', '#94706e', '#766d94', '#b58c59', '#567d79'][seed % 6],
    skin: ['#bc8b67', '#d7ad88', '#946b50', '#e2bb97'][seed % 4],
    hair: ['#3d352f', '#4c3d30', '#272e30'][seed % 3],
  };
}

function drawDesk(employee) {
  const { shirt, skin, hair } = agentAppearance(employee.id);
  const desk = svg('g', { transform: `translate(${employee.x - 18} ${employee.y + 7})` });
  desk.append(
    svg('ellipse', { cx: 9, cy: 91, rx: 72, ry: 17, fill: '#48565c', opacity: '.065' }),
    // The far legs sit behind the desk. Warm wood keeps the addition close to the illustration.
    svg('path', { d: 'M-67 14v60l6 3V15M60 24v60l6 3V21M3 52v45l6 3V52', fill: '#a78e6d' }),
    svg('path', { d: 'M-73 6-9-29 72 18 8 53Z', fill: '#e6cfaa', stroke: '#bea982', 'stroke-width': '1' }),
    svg('path', { d: 'M-73 6v7L8 60v-7ZM8 53v7l64-35v-7Z', fill: '#c6ab81' }),
    svg('path', { d: 'M-68 6-9-26 66 18 8 49Z', fill: '#ecd9b9', opacity: '.75' }),
    // A single monitor, keyboard, and mouse are the only tabletop objects.
    svg('path', { d: 'm-24 6 19-10 13 7-19 11Z', fill: '#7b8789' }),
    svg('path', { d: 'M-14-19v25l6 3v-28Z', fill: '#68777b' }),
    svg('path', { d: 'm-51-39 40-23 5 3-40 24Z', fill: '#647980' }),
    svg('path', { d: 'M-51-39-11-62v47L-51 8Z', fill: '#40535d' }),
    svg('path', { d: 'M-47-36-15-54v35L-47 0Z', fill: '#dceef1' }),
    svg('path', { d: 'm-44-31 25-14m-25 20 16-9m-16 15 25-14m-25 20 20-11', fill: 'none', stroke: '#80b3ca', 'stroke-width': '2.3' }),
    svg('path', { d: 'm-20 14 22-12 24 14L4 28Z', fill: '#f6f4ec', stroke: '#b4b6ac', 'stroke-width': '.8' }),
    svg('path', { d: 'm-13 14 13-7m-8 11 13-7m-7 11 13-7', stroke: '#acb4b0', 'stroke-width': '1.3' }),
    svg('ellipse', { cx: 38, cy: 22, rx: 5, ry: 3.5, fill: '#faf8f0', transform: 'rotate(28 38 22)' }),
    // Chair pedestal and feet remain stationary, just like the original employees.
    svg('path', { d: 'M24 59v24m0 0-19 5m19-5 21 7m-21-7 3 12', stroke: '#526164', 'stroke-width': '3.5', 'stroke-linecap': 'round', fill: 'none' }),
    svg('circle', { cx: 5, cy: 89, r: 3, fill: '#405055' }),
    svg('circle', { cx: 45, cy: 91, r: 3, fill: '#405055' }),
    svg('circle', { cx: 27, cy: 96, r: 3, fill: '#405055' }),
    // Shoes and trousers, partly visible beneath the chair.
    svg('path', { d: 'M10 49 3 70-10 75m33-23-2 22-12 8', stroke: '#3c4b53', 'stroke-width': '8', 'stroke-linecap': 'round', fill: 'none' }),
    svg('path', { d: 'm-12 75 9 2m8 6 10 1', stroke: '#313b40', 'stroke-width': '5', 'stroke-linecap': 'round' }),
    svg('ellipse', { cx: 22, cy: 53, rx: 19, ry: 10, fill: '#5f7174' }),
    // A seated employee facing their computer, with a clearly defined head for the hit target.
    svg('path', { d: 'M11 5C3 12 0 29 4 44l31 5c4-16 0-29-8-39Z', fill: shirt }),
    svg('path', { d: 'M6 14-1 29-11 22m38-4 8 15-5 2', stroke: shirt, 'stroke-width': '8', 'stroke-linecap': 'round', fill: 'none' }),
    svg('path', { d: 'm-11 22-5-3m47 16 3-6', stroke: skin, 'stroke-width': '5', 'stroke-linecap': 'round' }),
    svg('path', { d: 'M15-3v12l8 2V-3Z', fill: skin }),
    svg('ellipse', { cx: 18, cy: -8, rx: 10, ry: 12, fill: skin, transform: 'rotate(-12 18 -8)' }),
    svg('path', { d: 'M8-7C3-26 29-27 29-11l-3 8-5-2-1-10-10 1Z', fill: hair }),
    svg('path', { d: 'M8 28c8-5 21-3 27 4v23c-9 5-18 3-26-1Z', fill: '#687e80', stroke: '#51696d', 'stroke-width': '1.5' }),
    svg('path', { d: 'M13 33c6-2 14-1 17 1v14c-5 2-11 1-16-1Z', fill: '#7e9190', opacity: '.55' }),
  );
  return desk;
}

/**
 * Rebuild the additional office wing and assign canvas coordinates to custom agents.
 * Existing employees and department geometry are never modified.
 * Labels and click targets are supplied by the main canvas at x/y/labelY.
 */
export function layoutExtraDesks({ employees, departments, element }) {
  element.replaceChildren();
  element.style.pointerEvents = 'none';
  const custom = employees.filter(employee => employee.isCustom);
  if (!custom.length) return { ...ORIGINAL };

  const groups = departments.map(department => ({ department, roster: custom.filter(employee => employee.departmentId === department.id) }))
    .filter(group => group.roster.length);
  const unassigned = custom.filter(employee => !departments.some(department => department.id === employee.departmentId));
  if (unassigned.length) groups.push({ department: { name: 'Unassigned', color: '#819b92' }, roster: unassigned });

  let top = WING.top;
  const routes = svg('g', { fill: 'none', 'stroke-width': '1.5', 'stroke-dasharray': '4 8', 'stroke-linecap': 'round', opacity: '.28' });
  const islands = svg('g');
  for (const { department, roster } of groups) {
    const rows = Math.ceil(roster.length / 3);
    const bottom = top + rows * WING.row + 90;
    const x = WING.x;
    const right = x + WING.width;
    const floorTop = top + 58;
    const surface = `${x},${floorTop + 34} ${x + 62},${floorTop} ${right},${floorTop} ${right},${bottom - 34} ${right - 62},${bottom} ${x},${bottom}`;
    const group = svg('g', { 'data-extra-department': department.id || 'unassigned' });
    group.append(
      svg('path', { d: `M${x} ${bottom}v10H${right - 62}l62-34v-10l-62 34Z`, fill: tint(department.color, .51) }),
      svg('polygon', { points: surface, fill: tint(department.color, .86), stroke: tint(department.color, .70), 'stroke-width': '1' }),
      svg('path', { d: `M${x + 1} ${floorTop + 35} ${x + 62} ${floorTop + 1}H${right - 1}`, fill: 'none', stroke: '#fff', 'stroke-width': '2', opacity: '.85' }),
      svg('circle', { cx: x + 12, cy: top + 12, r: 5, fill: department.color || '#819b92' }),
      text(department.name, { x: x + 27, y: top + 18, fill: '#2f3f45', 'font-family': 'Inter, ui-sans-serif, system-ui, sans-serif', 'font-size': '17', 'font-weight': '650', 'letter-spacing': '-.2' }),
      text(`Additional desks · ${roster.length} configured`, { x: x + 27, y: top + 39, fill: '#7b8584', 'font-family': 'Inter, ui-sans-serif, system-ui, sans-serif', 'font-size': '12.5', 'font-weight': '450' }),
    );
    if (Number.isFinite(department.x) && Number.isFinite(department.y)) {
      const targetY = floorTop + 38;
      routes.append(svg('path', {
        d: `M${department.x + 60} ${department.y + 70}C${1300} ${department.y + 80} ${x - 80} ${targetY} ${x} ${targetY}`,
        stroke: department.color || '#819b92',
      }));
    }
    roster.forEach((employee, index) => {
      employee.x = x + 110 + (index % 3) * WING.column;
      employee.y = top + 142 + Math.floor(index / 3) * WING.row;
      employee.labelY = employee.y - 67;
      group.append(drawDesk(employee));
    });
    islands.append(group);
    top = bottom + 46;
  }

  const bounds = { width: Math.max(ORIGINAL.width, WING.x + WING.width + 60), height: Math.max(ORIGINAL.height, top + 20) };
  const canvas = svg('svg', { width: bounds.width, height: bounds.height, viewBox: `0 0 ${bounds.width} ${bounds.height}`, 'aria-hidden': 'true', focusable: 'false' });
  canvas.style.cssText = 'position:absolute;left:0;top:0;overflow:visible;pointer-events:none;stroke:none';
  canvas.append(routes, islands);
  element.append(canvas);
  return bounds;
}
