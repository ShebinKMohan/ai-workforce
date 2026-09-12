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

/** One room grows around its entire roster; there are no overflow desks outside it. */
function roomFor(department, agents) {
  const roster = agents.filter((agent) => agent.departmentId === department.id).sort(order);
  const head = roster.find((agent) => agent.id === department.headAgentId)
    ?? roster.find((agent) => (agent.workspaceRole ?? agent.role) === 'head');
  const workers = roster.filter((agent) => agent !== head);
  const columns = Math.max(1, Math.ceil(Math.sqrt(workers.length)));
  const workerRows = Math.ceil(workers.length / columns);
  const rows = Math.max(1, workerRows + (head ? 1 : 0));
  const m = OFFICE_METRICS;
  const width = Math.max(6, (columns - 1) * m.columnPitch + 2 * m.seatHalfWidth + 2 * m.wallClearance);
  const depth = Math.max(6, (rows - 1) * m.rowPitch + m.seatFront + m.seatBack + 2 * m.wallClearance);
  const front = -depth / 2 + m.wallClearance + m.seatFront;
  const seats = [];
  if (head) seats.push({ agentId: head.id, role: 'head', x: 0, z: front, rotationY: 0 });
  workers.forEach((agent, index) => {
    const row = Math.floor(index / columns);
    const inRow = Math.min(columns, workers.length - row * columns);
    const column = index % columns;
    seats.push({ agentId: agent.id, role: agent.workspaceRole ?? agent.role ?? 'worker', x: (column - (inRow - 1) / 2) * m.columnPitch, z: front + (row + (head ? 1 : 0)) * m.rowPitch, rotationY: 0 });
  });
  return { id: department.id, name: department.name ?? department.id, width, depth, seats, headAgentId: head?.id ?? null };
}

const neededRadius = (a, b, delta) => Math.abs(delta) < EPSILON ? Infinity : (a + b + OFFICE_METRICS.roomGap) / Math.abs(delta);
const edges = (x, z, halfWidth, halfDepth) => ({ minX: x - halfWidth, maxX: x + halfWidth, minZ: z - halfDepth, maxZ: z + halfDepth, width: halfWidth * 2, depth: halfDepth * 2 });

/**
 * Room positions and bounds are world coordinates; seat x/z are ROOM-LOCAL.
 * Put the room group at (x, 0, z), rotate it by rotationY, then add its seats.
 * Every desk faces local -Z, with its chair at +Z. Rotation points -Z at center.
 * A conservative ring is sized against every pair's rotated axis-aligned bounds,
 * so even rectangular rooms with very different roster sizes remain separated.
 */
export function buildSceneLayout({ departments = [], agents = [] } = {}) {
  const configuredDepartments = live(departments).filter((department) => department.template !== true && department.configured !== false);
  const configuredAgents = live(agents).filter((agent) => agent.template !== true && agent.kind !== 'open' && agent.configured !== false);
  uniqueIds(configuredDepartments, 'department');
  uniqueIds(configuredAgents, 'agent');
  const center = { id: 'control', x: 0, z: 0, width: OFFICE_METRICS.centerWidth, depth: OFFICE_METRICS.centerDepth, rotationY: 0 };
  center.worldBounds = edges(0, 0, center.width / 2, center.depth / 2);
  const rooms = [...configuredDepartments].sort(order).map((department) => roomFor(department, configuredAgents));
  const n = rooms.length;
  if (!n) return { center, departments: [], bounds: { ...center.worldBounds, centerX: 0, centerZ: 0 }, metrics: OFFICE_METRICS };

  // The first department sits beyond the coordinator; subsequent rooms surround it.
  // Stable department IDs determine order, independently of API array ordering.
  rooms.forEach((room, index) => {
    const angle = Math.PI + index * Math.PI * 2 / n;
    room.rotationY = angle;
    room.rotation = angle;
    room.direction = { x: Math.sin(angle), z: Math.cos(angle) };
    room.halfWidth = Math.abs(Math.cos(angle)) * room.width / 2 + Math.abs(Math.sin(angle)) * room.depth / 2;
    room.halfDepth = Math.abs(Math.sin(angle)) * room.width / 2 + Math.abs(Math.cos(angle)) * room.depth / 2;
  });
  let radius = 0;
  for (const room of rooms) {
    radius = Math.max(radius, Math.min(neededRadius(room.halfWidth, center.width / 2, room.direction.x), neededRadius(room.halfDepth, center.depth / 2, room.direction.z)));
  }
  for (let i = 0; i < n; i += 1) for (let j = i + 1; j < n; j += 1) {
    const a = rooms[i];
    const b = rooms[j];
    radius = Math.max(radius, Math.min(neededRadius(a.halfWidth, b.halfWidth, a.direction.x - b.direction.x), neededRadius(a.halfDepth, b.halfDepth, a.direction.z - b.direction.z)));
  }
  radius += 1e-6; // Preserve the clearance after floating-point rotation and translation.
  const result = rooms.map(({ direction, halfWidth, halfDepth, ...room }) => {
    const x = direction.x * radius;
    const z = direction.z * radius;
    return { ...room, x, z, worldBounds: edges(x, z, halfWidth, halfDepth) };
  });
  const all = [center.worldBounds, ...result.map((room) => room.worldBounds)];
  const minX = Math.min(...all.map((box) => box.minX));
  const maxX = Math.max(...all.map((box) => box.maxX));
  const minZ = Math.min(...all.map((box) => box.minZ));
  const maxZ = Math.max(...all.map((box) => box.maxZ));
  return { center, departments: result, bounds: { minX, maxX, minZ, maxZ, width: maxX - minX, depth: maxZ - minZ, centerX: (minX + maxX) / 2, centerZ: (minZ + maxZ) / 2 }, metrics: OFFICE_METRICS };
}

export const layoutScene = buildSceneLayout;
