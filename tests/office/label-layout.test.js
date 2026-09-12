/**
 * The office UI's own label-layout tests, ported from node:test to vitest so
 * they run in workforce's suite. The layout code itself is unchanged; the seat
 * labels now carry what the office renders (agent ids and open desks) instead
 * of the prototype's invented employee names.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { placeLabels } from '../../web/office/src/label-layout.js';
import { seats } from '../../web/office/src/data.js';

const NAMES = ['planner', 'engineer-codex', 'engineer-claude', 'Open desk'];

function assertSeparated(items, gap = 3) {
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      const separate = a.x + a.width + gap <= b.x + 1e-6 || b.x + b.width + gap <= a.x + 1e-6 ||
        a.y + a.height + gap <= b.y + 1e-6 || b.y + b.height + gap <= a.y + 1e-6;
      assert.ok(separate, `${a.id} and ${b.id} must retain their label gutter`);
    }
  }
}

function seatLabels(scale) {
  return seats.map((seat, index) => {
    const name = NAMES[index % NAMES.length];
    const width = name.length * 5.5 + 18;
    return { id: seat.id, name, x: seat.x * scale - width / 2, y: seat.labelY * scale - 20, width, height: 20 };
  });
}

test('all 24 seat nameplates remain separate at a narrow 0.23 canvas scale', () => {
  const input = seatLabels(0.23);
  const original = structuredClone(input);
  const output = placeLabels(input);
  assert.equal(output.length, 24);
  assert.deepEqual(output.map(item => item.id), input.map(item => item.id));
  assert.deepEqual(input, original, 'seat/name input must not be mutated');
  assertSeparated(output);
  for (let i = 0; i < output.length; i++) {
    assert.ok(Math.hypot(output[i].x - input[i].x, output[i].y - input[i].y) <= 80, 'ordinary seat labels should stay close to their desk');
  }
});

test('department headings and varied long names share one collision layout', () => {
  const scale = 0.23;
  const headings = [
    ['research', 440, 30, 98], ['engineering', 1030, 30, 118],
    ['design', 245, 360, 78], ['marketing', 1160, 385, 150],
    ['operations', 422, 674, 174], ['support', 967, 680, 140],
  ].map(([id, x, y, width]) => ({ id: `heading-${id}`, x: x * scale - width / 2, y: y * scale - 22, width, height: 22 }));
  const names = seatLabels(scale).map((item, i) => {
    if (i % 5) return item;
    return { ...item, name: `${item.name}-with-a-long-suffix`, x: item.x - 30, width: item.width + 60, height: 32 };
  });
  const output = placeLabels([...headings, ...names], { gap: 4 });
  assert.equal(output.length, 30);
  assertSeparated(output, 4);
  assert.deepEqual(output.map(item => item.name), [...headings, ...names].map(item => item.name));
});

test('placement is deterministic and does not move labels that already fit', () => {
  const input = seatLabels(0.66);
  assert.deepEqual(placeLabels(input), placeLabels(structuredClone(input)));
  const separated = [
    { id: 'a', x: 0, y: 0, width: 80, height: 20 },
    { id: 'b', x: 90, y: 0, width: 120, height: 20 },
  ];
  assert.deepEqual(placeLabels(separated), separated);
});

test('nearest equal-distance placements favor vertical displacement', () => {
  const input = [
    { id: 'fixed', x: 0, y: 0, width: 20, height: 20 },
    { id: 'moved', x: 0, y: 0, width: 20, height: 20 },
  ];
  const output = placeLabels(input);
  assert.deepEqual(output[0], input[0]);
  assert.equal(output[1].x, 0);
  assert.equal(output[1].y, -23);
  assertSeparated(output);
});

test('a crowded group overflows the preferred radius without dropping names', () => {
  const input = Array.from({ length: 12 }, (_, i) => ({ id: `agent-${i}`, x: 0, y: 0, width: 160, height: 40 }));
  const output = placeLabels(input);
  assert.equal(output.length, input.length);
  assertSeparated(output);
  assert.deepEqual(output.map(item => item.id), input.map(item => item.id));
});

test('horizontal scene bounds retain every narrow-view label without collisions', () => {
  const input = seatLabels(0.23);
  input[4] = { ...input[4], width: 155, x: input[4].x - 30, height: 30 };
  const bounds = { left: -24, right: 1402 * 0.23 + 24 };
  const output = placeLabels(input, { bounds });
  assert.equal(output.length, 24);
  assertSeparated(output);
  for (const item of output) {
    assert.ok(item.x >= bounds.left - 1e-6, `${item.id} must stay within the left edge`);
    assert.ok(item.x + item.width <= bounds.right + 1e-6, `${item.id} must stay within the right edge`);
  }
  assert.deepEqual(output, placeLabels(input, { bounds }), 'bounded placement must remain deterministic');
});

test('preferred origins clamp horizontally before a collision-free position is accepted', () => {
  const input = [
    { id: 'left', x: -60, y: 0, width: 80, height: 20 },
    { id: 'right', x: 200, y: 60, width: 80, height: 20 },
  ];
  const output = placeLabels(input, { bounds: { left: 0, right: 180 } });
  assert.equal(output[0].x, 0);
  assert.equal(output[1].x, 100);
  assert.equal(output[0].y, input[0].y);
  assert.equal(output[1].y, input[1].y);
  assert.equal(input[0].x, -60, 'clamping must not change input anchors');
});

test('labels wider than the available horizontal strip fail explicitly', () => {
  assert.throws(() => placeLabels([{ id: 'wide', x: 0, y: 0, width: 101, height: 20 }], {
    bounds: { left: 0, right: 100 },
  }), { name: 'RangeError', message: /wide.*wider/ });
  assert.throws(() => placeLabels([], { bounds: { left: 100, right: 0 } }), TypeError);
});
