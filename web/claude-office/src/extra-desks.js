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

// Reuse a complete illustrated workstation from the same source artwork. This is
// a visual avatar, never a claim that the source illustration's person is an agent.
const WORKSTATIONS = {
  research: { left: 350, top: 82, width: 145, height: 128, x: 437, y: 128 },
  engineering: { left: 949, top: 83, width: 162, height: 141, x: 1040, y: 128 },
  design: { left: 178, top: 407, width: 143, height: 128, x: 236, y: 456 },
  marketing: { left: 1079, top: 432, width: 143, height: 132, x: 1164, y: 479 },
  operations: { left: 350, top: 722, width: 143, height: 133, x: 414, y: 772 },
  support: { left: 881, top: 731, width: 140, height: 129, x: 965, y: 778 },
};

function drawDesk(employee, department) {
  const source = WORKSTATIONS[department.sceneId || department.id] || WORKSTATIONS.engineering;
  const crop = svg('foreignObject', { x: employee.x - (source.x - source.left), y: employee.y - (source.y - source.top), width: source.width, height: source.height, 'data-illustrated-workstation': employee.id });
  const image = document.createElement('div');
  image.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  image.style.cssText = `width:100%;height:100%;background-image:url('/assets/office-clean.png');background-size:1402px 1122px;background-position:-${source.left}px -${source.top}px;background-repeat:no-repeat;pointer-events:none;mask-image:linear-gradient(to right,transparent,#000 6px,#000 calc(100% - 6px),transparent),linear-gradient(to bottom,transparent,#000 6px,#000 calc(100% - 6px),transparent);mask-composite:intersect`;
  crop.append(image);
  return crop;
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
  let maxRight = ORIGINAL.width;
  const routes = svg('g', { fill: 'none', 'stroke-width': '1.5', 'stroke-dasharray': '4 8', 'stroke-linecap': 'round', opacity: '.28' });
  const islands = svg('g');
  for (const { department, roster } of groups) {
    const columns = Math.min(3, roster.length);
    const rows = Math.ceil(roster.length / columns);
    const wingWidth = 70 + columns * WING.column;
    const bottom = top + rows * WING.row + 35;
    const x = WING.x;
    const right = x + wingWidth;
    maxRight = Math.max(maxRight, right);
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
      employee.x = x + 115 + (index % columns) * WING.column;
      employee.y = top + 128 + Math.floor(index / columns) * WING.row;
      employee.labelY = employee.y - 45;
      group.append(drawDesk(employee, department));
    });
    islands.append(group);
    top = bottom + 46;
  }

  const bounds = { width: Math.max(ORIGINAL.width, maxRight + 40), height: Math.max(ORIGINAL.height, top + 20) };
  const canvas = svg('svg', { width: bounds.width, height: bounds.height, viewBox: `0 0 ${bounds.width} ${bounds.height}`, 'aria-hidden': 'true', focusable: 'false' });
  canvas.style.cssText = 'position:absolute;left:0;top:0;overflow:visible;pointer-events:none;stroke:none';
  canvas.append(routes, islands);
  element.append(canvas);
  return bounds;
}
