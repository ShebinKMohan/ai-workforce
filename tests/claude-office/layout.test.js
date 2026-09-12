import { describe, expect, it } from 'vitest';
import { buildSceneLayout, OFFICE_METRICS as m } from '../../web/claude-office/src/scene-layout.js';

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
    expect(room.seats[0].x).toBe(0);
    const seatBounds = room.seats.map((seat) => ({ minX: seat.x - m.seatHalfWidth, maxX: seat.x + m.seatHalfWidth, minZ: seat.z - m.seatFront, maxZ: seat.z + m.seatBack }));
    for (const box of seatBounds) {
      expect(box.minX).toBeGreaterThanOrEqual(-room.width / 2 + m.wallClearance - 1e-8);
      expect(box.maxX).toBeLessThanOrEqual(room.width / 2 - m.wallClearance + 1e-8);
      expect(box.minZ).toBeGreaterThanOrEqual(-room.depth / 2 + m.wallClearance - 1e-8);
      expect(box.maxZ).toBeLessThanOrEqual(room.depth / 2 - m.wallClearance + 1e-8);
    }
    for (let i = 0; i < seatBounds.length; i += 1) for (let j = i + 1; j < seatBounds.length; j += 1) expect(separated(seatBounds[i], seatBounds[j], 0.5)).toBe(true);
    for (const seat of room.seats.slice(1)) expect(seat.z).toBeGreaterThan(room.seats[0].z);
    // Every rotated floor corner remains in the reported world/camera bounds.
    for (const x of [-room.width / 2, room.width / 2]) for (const z of [-room.depth / 2, room.depth / 2]) {
      const wx = room.x + x * Math.cos(room.rotationY) + z * Math.sin(room.rotationY);
      const wz = room.z - x * Math.sin(room.rotationY) + z * Math.cos(room.rotationY);
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
    expect(room.seats[0].z - m.seatFront).toBeGreaterThanOrEqual(-room.depth / 2 + m.wallClearance);
    expect(room.seats[0].z + m.seatBack).toBeLessThanOrEqual(room.depth / 2 - m.wallClearance);
    const displayed = buildSceneLayout({ departments: [{ id: 'team' }], agents: [{ id: 'lead', departmentId: 'team', role: 'Department head', workspaceRole: 'head' }] });
    expect(displayed.departments[0].seats[0]).toMatchObject({ agentId: 'lead', role: 'head', x: 0 });
  });

  it('rejects duplicate agent or department identities instead of drawing double occupancy', () => {
    expect(() => buildSceneLayout({ departments: [{ id: 'same' }, { id: 'same' }] })).toThrow('Duplicate department');
    expect(() => buildSceneLayout({ agents: [{ id: 'same' }, { id: 'same' }] })).toThrow('Duplicate agent');
  });
});
