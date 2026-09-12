import { describe, expect, it } from 'vitest';
import { buildSceneLayout, campusSlots, OFFICE_METRICS as m } from '../../web/claude-office/src/scene-layout.js';
import { createCentralIsland } from '../../web/claude-office/src/scene-campus.js';

function office(sizes) {
  const departments = sizes.map((_, index) => ({ id: `department-${String(index).padStart(3, '0')}`, name: `Department ${index}`, headAgentId: `head-${index}` }));
  const agents = departments.flatMap((department, index) => [
    { id: department.headAgentId, departmentId: department.id, role: 'head' },
    ...Array.from({ length: sizes[index] }, (_, worker) => ({ id: `worker-${index}-${String(worker).padStart(4, '0')}`, departmentId: department.id, role: 'worker' })),
  ]);
  return { departments, agents };
}

function separated(a, b, gap = 0) {
  const tolerance = 1e-7;
  return a.maxX + gap <= b.minX + tolerance || b.maxX + gap <= a.minX + tolerance || a.maxZ + gap <= b.minZ + tolerance || b.maxZ + gap <= a.minZ + tolerance;
}

function verifyLayout(layout, input) {
  expect(layout.departments).toHaveLength(input.departments.length);
  expect(layout.departments.flatMap((room) => room.seats.map((seat) => seat.agentId)).sort()).toEqual(input.agents.map((agent) => agent.id).sort());
  const boxes = [layout.center.worldBounds, ...layout.departments.map((room) => room.worldBounds)];
  for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) expect(separated(boxes[i], boxes[j], m.roomGap)).toBe(true);
  for (const room of layout.departments) {
    const worldForward = { x: -Math.sin(room.rotationY), z: -Math.cos(room.rotationY) };
    const radius = Math.hypot(room.x, room.z);
    expect(worldForward.x).toBeCloseTo(-room.x / radius, 8);
    expect(worldForward.z).toBeCloseTo(-room.z / radius, 8);
    expect(room.seats[0].role).toBe('head');
    expect(room.floorRotationY).toBe(0);
    const seatBounds = room.seats.map((seat) => {
      expect(seat.rotationY).toBe(room.rotationY);
      const corners = [];
      for (const x of [-m.seatHalfWidth, m.seatHalfWidth]) for (const z of [-m.seatFront, m.seatBack]) corners.push({ x: seat.x + x * Math.cos(seat.rotationY) + z * Math.sin(seat.rotationY), z: seat.z - x * Math.sin(seat.rotationY) + z * Math.cos(seat.rotationY) });
      return { minX: Math.min(...corners.map(p => p.x)), maxX: Math.max(...corners.map(p => p.x)), minZ: Math.min(...corners.map(p => p.z)), maxZ: Math.max(...corners.map(p => p.z)) };
    });
    for (const box of seatBounds) {
      expect(box.minX).toBeGreaterThanOrEqual(-room.width / 2 + m.wallClearance - 1e-8);
      expect(box.maxX).toBeLessThanOrEqual(room.width / 2 - m.wallClearance + 1e-8);
      expect(box.minZ).toBeGreaterThanOrEqual(-room.depth / 2 + m.wallClearance - 1e-8);
      expect(box.maxZ).toBeLessThanOrEqual(room.depth / 2 - m.wallClearance + 1e-8);
    }
    for (let i = 0; i < seatBounds.length; i += 1) for (let j = i + 1; j < seatBounds.length; j += 1) expect(separated(seatBounds[i], seatBounds[j], 0.5)).toBe(true);
    const headProjection = room.seats[0].x * worldForward.x + room.seats[0].z * worldForward.z;
    for (const seat of room.seats.slice(1)) expect(headProjection).toBeGreaterThan(seat.x * worldForward.x + seat.z * worldForward.z);
    // Every rotated floor corner remains in the reported world/camera bounds.
    for (const x of [-room.width / 2, room.width / 2]) for (const z of [-room.depth / 2, room.depth / 2]) {
      const wx = room.x + x * Math.cos(room.floorRotationY) + z * Math.sin(room.floorRotationY);
      const wz = room.z - x * Math.sin(room.floorRotationY) + z * Math.cos(room.floorRotationY);
      expect(wx).toBeGreaterThanOrEqual(layout.bounds.minX - 1e-7);
      expect(wx).toBeLessThanOrEqual(layout.bounds.maxX + 1e-7);
      expect(wz).toBeGreaterThanOrEqual(layout.bounds.minZ - 1e-7);
      expect(wz).toBeLessThanOrEqual(layout.bounds.maxZ + 1e-7);
    }
  }
}

describe('configured 3D office layout', () => {
  it('renders only the central control for an empty workspace', () => {
    const layout = buildSceneLayout();
    expect(layout.departments).toEqual([]);
    expect(layout.center).toMatchObject({ x: 0, z: 0, width: 6, depth: 6 });
    expect(layout.bounds).toMatchObject({ minX: -3, maxX: 3, minZ: -3, maxZ: 3 });
  });

  it('keeps the control platform convex and symmetric on the department floor axes', () => {
    const island = createCentralIsland();
    const points = island.userData.pickSurface.geometry.parameters.shapes.getPoints(24);
    // The concave shoulders in the former hub created the irregular silhouette.
    // All visible perimeter turns must now retain one winding direction.
    const turns = points.map((point, index) => {
      const next = points[(index + 1) % points.length];
      const after = points[(index + 2) % points.length];
      return (next.x - point.x) * (after.y - next.y) - (next.y - point.y) * (after.x - next.x);
    }).filter(turn => Math.abs(turn) > 1e-8);
    expect(turns.length).toBeGreaterThan(4);
    expect(turns.every(turn => Math.sign(turn) === Math.sign(turns[0]))).toBe(true);
    for (const point of points) {
      expect(points.some(other => Math.abs(other.x + point.x) < 1e-7 && Math.abs(other.y - point.y) < 1e-7)).toBe(true);
      expect(points.some(other => Math.abs(other.x - point.x) < 1e-7 && Math.abs(other.y + point.y) < 1e-7)).toBe(true);
    }
    const materials = new Set();
    island.traverse(object => { object.geometry?.dispose();for (const material of [].concat(object.material || [])) materials.add(material); });
    materials.forEach(material => material.dispose());
  });

  it('does not turn unconfigured illustration templates into rooms or people', () => {
    const layout = buildSceneLayout({ departments: [{ id: 'template', template: true }, { id: 'unused', configured: false }], agents: [{ id: 'open', departmentId: 'unused', kind: 'open' }] });
    expect(layout.departments).toEqual([]);
  });

  it.each([1, 2, 6, 12])('keeps all rooms, chairs and head desks separate with %i departments', (count) => {
    const input = office(Array.from({ length: count }, (_, index) => [0, 1, 4, 25, 7, 49][index % 6]));
    verifyLayout(buildSceneLayout(input), input);
  });

  it('grows one department around the fifth and twenty-fifth agent without overflow', () => {
    const four = buildSceneLayout(office([3]));
    const five = buildSceneLayout(office([4]));
    const twentyFive = buildSceneLayout(office([24]));
    expect(five.departments).toHaveLength(1);
    expect(five.departments[0].seats).toHaveLength(5);
    expect(twentyFive.departments).toHaveLength(1);
    expect(twentyFive.departments[0].seats).toHaveLength(25);
    expect(twentyFive.departments[0].width * twentyFive.departments[0].depth).toBeGreaterThan(four.departments[0].width * four.departments[0].depth);
    verifyLayout(twentyFive, office([24]));
  });

  it('keeps a large uneven office bounded and retains every agent ID', () => {
    const input = office([120, 0, 1, 100, 2, 25, 6, 18, 3, 9, 70, 4]);
    verifyLayout(buildSceneLayout(input), input);
  });

  it('ignores archived and orphaned configuration and never mutates input', () => {
    const input = office([3]);
    input.departments.push({ id: 'archived', archived: true });
    input.agents.push({ id: 'archived-worker', departmentId: 'archived', role: 'worker' }, { id: 'retired', departmentId: input.departments[0].id, archived: true }, { id: 'orphan', departmentId: 'missing' });
    const before = structuredClone(input);
    for (const row of [...input.departments, ...input.agents]) Object.freeze(row);
    Object.freeze(input.departments); Object.freeze(input.agents); Object.freeze(input);
    const layout = buildSceneLayout(input);
    expect(layout.departments).toHaveLength(1);
    expect(layout.departments[0].seats).toHaveLength(4);
    expect(input).toEqual(before);
  });

  it('is deterministic when API arrays reorder and places the named head first', () => {
    const input = office([5, 3, 1]);
    const first = buildSceneLayout(input);
    const second = buildSceneLayout({ departments: [...input.departments].reverse(), agents: [...input.agents].reverse() });
    expect(second).toEqual(first);
    for (const room of first.departments) expect(room.seats[0].agentId).toBe(input.departments.find((department) => department.id === room.id).headAgentId);
  });

  it('keeps a department with no head or no members useful without inventing people', () => {
    const layout = buildSceneLayout({ departments: [{ id: 'empty' }, { id: 'workers' }], agents: [{ id: 'worker', departmentId: 'workers', role: 'worker' }] });
    expect(layout.departments.find((room) => room.id === 'empty').seats).toEqual([]);
    expect(layout.departments.find((room) => room.id === 'workers').seats).toEqual([expect.objectContaining({ agentId: 'worker', role: 'worker' })]);
    const room = layout.departments.find((item) => item.id === 'workers');
    expect(room.floorRotationY).toBe(0);
    expect(room.seats[0].rotationY).toBe(room.rotationY);
    const displayed = buildSceneLayout({ departments: [{ id: 'team' }], agents: [{ id: 'lead', departmentId: 'team', role: 'Department head', workspaceRole: 'head' }] });
    expect(displayed.departments[0].seats[0]).toMatchObject({ agentId: 'lead', role: 'head' });
  });

  it('uses the reference campus slots and expands onto distinct outer hex rings', () => {
    expect(campusSlots(6)).toEqual([{ x: -1, z: 0 }, { x: 0, z: -1 }, { x: -1, z: 1 }, { x: 1, z: -1 }, { x: 0, z: 1 }, { x: 1, z: 0 }]);
    const layout = buildSceneLayout(office(Array(30).fill(3)));
    expect(new Set(layout.departments.map(room => `${room.campusSlot.x},${room.campusSlot.z}`)).size).toBe(30);
    verifyLayout(layout, office(Array(30).fill(3)));
  });

  it('preserves existing campus slots when a department is added or removed', () => {
    const input = office([1, 2]);
    const first = buildSceneLayout(input);
    const added = buildSceneLayout({ departments: [{ id: 'aaa-new' }, ...input.departments], agents: input.agents, previousLayout: first });
    for (const room of first.departments) expect(added.departments.find(next => next.id === room.id).campusSlot).toEqual(room.campusSlot);
    const removed = buildSceneLayout({ departments: input.departments.slice(1), agents: input.agents, previousLayout: added });
    expect(removed.departments[0].campusSlot).toEqual(first.departments[1].campusSlot);
  });

  it('clips physical walkway endpoints to the center and department floor boundaries', () => {
    const layout = buildSceneLayout(office(Array(6).fill(3)));
    expect(layout.paths).toHaveLength(6);
    for (const path of layout.paths) {
      const room = layout.departments.find(item => item.id === path.departmentId);
      expect(Math.max(Math.abs(path.from.x) / 3, Math.abs(path.from.z) / 3)).toBeCloseTo(1);
      expect(Math.max(Math.abs(path.to.x - room.x) / (room.width / 2), Math.abs(path.to.z - room.z) / (room.depth / 2))).toBeCloseTo(1);
      expect(Math.hypot(path.to.x, path.to.z)).toBeGreaterThan(Math.hypot(path.from.x, path.from.z));
      expect(path.width).toBeGreaterThan(1);
    }
  });

  it('connects thirty departments through inner neighbours without bridges crossing unrelated floors', () => {
    const layout = buildSceneLayout(office(Array(30).fill(3)));
    expect(layout.paths).toHaveLength(30);
    const ring = (room) => Math.max(Math.abs(room.campusSlot.x), Math.abs(room.campusSlot.z), Math.abs(room.campusSlot.x + room.campusSlot.z));
    for (const path of layout.paths) {
      const target = layout.departments.find((room) => room.id === path.departmentId);
      if (ring(target) === 1) expect(path.fromDepartmentId).toBeNull();
      else {
        const parent = layout.departments.find((room) => room.id === path.fromDepartmentId);
        expect(parent).toBeDefined();
        expect(ring(parent)).toBeLessThan(ring(target));
      }
      const unrelated = [layout.center, ...layout.departments].filter((room) => room.id !== path.departmentId && room.id !== (path.fromDepartmentId ?? 'control'));
      for (let step = 0; step <= 100; step += 1) {
        const x = path.from.x + (path.to.x - path.from.x) * step / 100;
        const z = path.from.z + (path.to.z - path.from.z) * step / 100;
        for (const room of unrelated) {
          const bounds = room.worldBounds;
          expect(x > bounds.minX - .5 && x < bounds.maxX + .5 && z > bounds.minZ - .5 && z < bounds.maxZ + .5).toBe(false);
        }
      }
    }
  });

  it('rejects duplicate agent or department identities instead of drawing double occupancy', () => {
    expect(() => buildSceneLayout({ departments: [{ id: 'same' }, { id: 'same' }] })).toThrow('Duplicate department');
    expect(() => buildSceneLayout({ agents: [{ id: 'same' }, { id: 'same' }] })).toThrow('Duplicate agent');
  });
});
