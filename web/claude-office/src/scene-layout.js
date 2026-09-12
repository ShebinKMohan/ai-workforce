/** Pure geometry for the configured 3D office. All measurements are world units. */
export const OFFICE_METRICS = Object.freeze({
  deskWidth: 1.8,
  deskDepth: 1.2,
  chairOffset: 1.05,
  columnPitch: 3.2,
  rowPitch: 3.5,
  seatHalfWidth: 1.1,
  seatFront: 0.8,
  seatBack: 1.7,
  wallClearance: 1,
  roomGap: 3,
  centerWidth: 6,
  centerDepth: 6,
});

const order = (a, b) => String(a.id).localeCompare(String(b.id), 'en');
const live = (items) => (Array.isArray(items) ? items : []).filter((item) => !item.archived);
const EPSILON = 1e-9;

function uniqueIds(items, kind) {
  const seen = new Set();
  for (const item of items) {
    if (typeof item.id !== 'string' || !item.id) throw new TypeError(`${kind} must have a nonempty string id.`);
    if (seen.has(item.id)) throw new TypeError(`Duplicate ${kind} id: ${item.id}`);
    seen.add(item.id);
  }
}

/** Inward-facing furniture on an unrotated floor. Workers retain a global-axis grid. */
function roomFor(department, agents, slot) {
  const roster = agents.filter((agent) => agent.departmentId === department.id).sort(order);
  const head = roster.find((agent) => agent.id === department.headAgentId)
    ?? roster.find((agent) => (agent.workspaceRole ?? agent.role) === 'head');
  const workers = roster.filter((agent) => agent !== head);
  const m = OFFICE_METRICS;
  const rotationY = Math.atan2(slot.x, slot.z);
  const sin = Math.sin(rotationY), cos = Math.cos(rotationY);
  const halfWidth = Math.abs(cos) * m.seatHalfWidth + Math.abs(sin) * (m.seatFront + m.seatBack) / 2;
  const halfDepth = Math.abs(sin) * m.seatHalfWidth + Math.abs(cos) * (m.seatFront + m.seatBack) / 2;
  const offsetX = sin * (m.seatBack - m.seatFront) / 2;
  const offsetZ = cos * (m.seatBack - m.seatFront) / 2;
  const pitchX = Math.max(m.columnPitch, halfWidth * 2 + .7);
  const pitchZ = Math.max(m.rowPitch, halfDepth * 2 + .7);
  const columns = Math.max(1, Math.ceil(Math.sqrt(workers.length)));
  const rows = Math.ceil(workers.length / columns);
  const seats = workers.map((agent, index) => {
    const row = Math.floor(index / columns);
    const inRow = Math.min(columns, workers.length - row * columns);
    return { agentId: agent.id, role: agent.workspaceRole ?? agent.role ?? 'worker', x: (index % columns - (inRow - 1) / 2) * pitchX - offsetX, z: (row - (rows - 1) / 2) * pitchZ - offsetZ, rotationY };
  });
  if (head) {
    const outwardX = sin, outwardZ = cos;
    // Keep the head ahead of every worker, including the whole rotated chair/desk.
    const projection = Math.abs(outwardX) * halfWidth + Math.abs(outwardZ) * halfDepth;
    const frontmost = seats.length ? Math.max(...seats.map((seat) => -(seat.x + offsetX) * outwardX - (seat.z + offsetZ) * outwardZ)) : 0;
    const distance = seats.length ? frontmost + 2 * projection + .9 : 0;
    seats.unshift({ agentId: head.id, role: 'head', x: -outwardX * distance - offsetX, z: -outwardZ * distance - offsetZ, rotationY });
  }
  const minX = seats.length ? Math.min(...seats.map((seat) => seat.x + offsetX - halfWidth)) - m.wallClearance : -3;
  const maxX = seats.length ? Math.max(...seats.map((seat) => seat.x + offsetX + halfWidth)) + m.wallClearance : 3;
  const minZ = seats.length ? Math.min(...seats.map((seat) => seat.z + offsetZ - halfDepth)) - m.wallClearance : -3;
  const maxZ = seats.length ? Math.max(...seats.map((seat) => seat.z + offsetZ + halfDepth)) + m.wallClearance : 3;
  const centerX = (minX + maxX) / 2, centerZ = (minZ + maxZ) / 2;
  for (const seat of seats) { seat.x -= centerX; seat.z -= centerZ; }
  return { id: department.id, name: department.name ?? department.id, width: Math.max(6, maxX - minX), depth: Math.max(6, maxZ - minZ), floorRotationY: 0, rotationY, rotation: rotationY, seats, headAgentId: head?.id ?? null, campusSlot: { ...slot } };
}

/** First ring follows the reference's upper-left/right, middle-left/right, lower-left/right. */
export function campusSlots(count) {
  const slots = [{ x: -1, z: 0 }, { x: 0, z: -1 }, { x: -1, z: 1 }, { x: 1, z: -1 }, { x: 0, z: 1 }, { x: 1, z: 0 }];
  for (let ring = 2; slots.length < count; ring += 1) {
    const outer = [];
    for (let x = -ring; x <= ring; x += 1) for (let z = -ring; z <= ring; z += 1) {
      if (Math.max(Math.abs(x), Math.abs(z), Math.abs(x + z)) === ring) outer.push({ x, z });
    }
    outer.sort((a, b) => Math.atan2(a.z, a.x) - Math.atan2(b.z, b.x));
    slots.push(...outer);
  }
  return slots.slice(0, count);
}

const neededRadius = (a, b, delta) => Math.abs(delta) < EPSILON ? Infinity : (a + b + OFFICE_METRICS.roomGap) / Math.abs(delta);
const edges = (x, z, halfWidth, halfDepth) => ({ minX: x - halfWidth, maxX: x + halfWidth, minZ: z - halfDepth, maxZ: z + halfDepth, width: halfWidth * 2, depth: halfDepth * 2 });

/**
 * Floors use world axes: floorRotationY is always zero. Seat x/z are local to
 * that unrotated floor; rotate each workstation by seat.rotationY only.
 * Optional previousLayout preserves each existing department's campus slot
 * across additions or removals. Spacing grows with room sizes, never occupancy.
 */
export function buildSceneLayout({ departments = [], agents = [], previousLayout = null } = {}) {
  const configuredDepartments = live(departments).filter((department) => department.template !== true && department.configured !== false);
  const configuredAgents = live(agents).filter((agent) => agent.template !== true && agent.kind !== 'open' && agent.configured !== false);
  uniqueIds(configuredDepartments, 'department');
  uniqueIds(configuredAgents, 'agent');
  const center = { id: 'control', x: 0, z: 0, width: OFFICE_METRICS.centerWidth, depth: OFFICE_METRICS.centerDepth, floorRotationY: 0, rotationY: 0 };
  center.worldBounds = edges(0, 0, center.width / 2, center.depth / 2);
  const sorted = [...configuredDepartments].sort(order);
  if (!sorted.length) return { center, departments: [], paths: [], bounds: { ...center.worldBounds, centerX: 0, centerZ: 0 }, metrics: OFFICE_METRICS };
  const oldSlots = new Map((previousLayout?.departments ?? []).filter((room) => room.campusSlot).map((room) => [room.id, room.campusSlot]));
  const used = new Set(sorted.filter((department) => oldSlots.has(department.id)).map((department) => { const slot = oldSlots.get(department.id); return `${slot.x},${slot.z}`; }));
  const available = campusSlots(sorted.length + used.size + 12).filter((slot) => !used.has(`${slot.x},${slot.z}`));
  const rooms = sorted.map((department) => roomFor(department, configuredAgents, oldSlots.get(department.id) ?? available.shift()));
  // A shared cell leaves clear axial and diagonal bridge corridors between floors.
  let spacing = Math.max(center.width, center.depth, ...rooms.flatMap((room) => [room.width, room.depth])) + OFFICE_METRICS.roomGap;
  for (const room of rooms) spacing = Math.max(spacing, Math.min(neededRadius(room.width / 2, center.width / 2, room.campusSlot.x), neededRadius(room.depth / 2, center.depth / 2, room.campusSlot.z)));
  for (let i = 0; i < rooms.length; i += 1) for (let j = i + 1; j < rooms.length; j += 1) {
    const a = rooms[i], b = rooms[j];
    spacing = Math.max(spacing, Math.min(neededRadius(a.width / 2, b.width / 2, a.campusSlot.x - b.campusSlot.x), neededRadius(a.depth / 2, b.depth / 2, a.campusSlot.z - b.campusSlot.z)));
  }
  spacing += 1e-6;
  const result = rooms.map((room) => {
    const x = room.campusSlot.x * spacing, z = room.campusSlot.z * spacing;
    return { ...room, x, z, worldBounds: edges(x, z, room.width / 2, room.depth / 2) };
  });
  const boundary = (room, dx, dz) => {
    const fraction = Math.min(Math.abs(dx) < EPSILON ? Infinity : room.width / 2 / Math.abs(dx), Math.abs(dz) < EPSILON ? Infinity : room.depth / 2 / Math.abs(dz));
    return { x: room.x + dx * fraction, z: room.z + dz * fraction };
  };
  const ringOf = (room) => room.campusSlot ? Math.max(Math.abs(room.campusSlot.x), Math.abs(room.campusSlot.z), Math.abs(room.campusSlot.x + room.campusSlot.z)) : 0;
  const crossesFloor = (from, to, room, clearance = .675) => {
    let start = 0, end = 1;
    for (const [axis, min, max] of [['x', room.worldBounds.minX - clearance, room.worldBounds.maxX + clearance], ['z', room.worldBounds.minZ - clearance, room.worldBounds.maxZ + clearance]]) {
      const delta = to[axis] - from[axis];
      if (Math.abs(delta) < EPSILON) { if (from[axis] < min || from[axis] > max) return false; continue; }
      const a = (min - from[axis]) / delta, b = (max - from[axis]) / delta;
      start = Math.max(start, Math.min(a, b)); end = Math.min(end, Math.max(a, b));
      if (start > end) return false;
    }
    return end > 0 && start < 1;
  };
  const paths = [];
  for (const room of [...result].sort((a, b) => ringOf(a) - ringOf(b) || order(a, b))) {
    const candidates = ringOf(room) === 1 ? [center] : [center, ...result.filter((candidate) => ringOf(candidate) < ringOf(room))].sort((a, b) => Math.hypot(a.x - room.x, a.z - room.z) - Math.hypot(b.x - room.x, b.z - room.z));
    for (const parent of candidates) {
      const from = boundary(parent, room.x - parent.x, room.z - parent.z);
      const to = boundary(room, parent.x - room.x, parent.z - room.z);
      if ([center, ...result].some((other) => other !== parent && other !== room && crossesFloor(from, to, other))) continue;
      paths.push({ departmentId: room.id, fromDepartmentId: parent === center ? null : parent.id, from, to, width: 1.35 });
      break;
    }
  }
  const all = [center.worldBounds, ...result.map((room) => room.worldBounds)];
  const minX = Math.min(...all.map((box) => box.minX)), maxX = Math.max(...all.map((box) => box.maxX));
  const minZ = Math.min(...all.map((box) => box.minZ)), maxZ = Math.max(...all.map((box) => box.maxZ));
  return { center, departments: result, paths, spacing, bounds: { minX, maxX, minZ, maxZ, width: maxX - minX, depth: maxZ - minZ, centerX: (minX + maxX) / 2, centerZ: (minZ + maxZ) / 2 }, metrics: OFFICE_METRICS };
}

export const layoutScene = buildSceneLayout;
