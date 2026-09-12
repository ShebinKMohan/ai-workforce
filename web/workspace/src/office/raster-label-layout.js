/**
 * Place rectangular labels around their intended screen coordinates.
 *
 * Input order is priority order: earlier labels keep their preferred positions.
 * The result preserves that order and all item fields; inputs are never changed.
 * Positions are top-left CSS pixels, independent of camera/world coordinates.
 * Optional bounds { left, right } keep every label inside a horizontal strip.
 * Preferred origins are clamped into that strip before collision placement.
 * A label wider than the strip throws RangeError instead of being hidden.
 *
 * Candidates come from rectangle edges, so the nearest available position is
 * found without a pixel-by-pixel search. Equal distances favor a vertical move.
 * Normal placement stays within 80px. An impossibly crowded group can overflow
 * that preference rather than dropping a name or returning overlapping labels.
 */
export function placeLabels(items, { gap = 3, bounds } = {}) {
  if (!Number.isFinite(gap) || gap < 0) throw new TypeError('Label gap must be a nonnegative finite number.');
  if (bounds && (!Number.isFinite(bounds.left) || !Number.isFinite(bounds.right) || bounds.right < bounds.left)) {
    throw new TypeError('Label bounds require finite left and right edges in increasing order.');
  }
  const placed = [];
  for (const item of items) {
    if (!['x', 'y', 'width', 'height'].every(key => Number.isFinite(item[key])) || item.width < 0 || item.height < 0) {
      throw new TypeError('Labels require finite coordinates and nonnegative dimensions.');
    }
    if (bounds && item.width > bounds.right - bounds.left) {
      throw new RangeError(`Label ${item.id ?? ''} is wider than the available horizontal bounds.`);
    }
    const origin = { ...item, x: bounds ? Math.max(bounds.left, Math.min(item.x, bounds.right - item.width)) : item.x };
    const inBounds = candidate => !bounds || (candidate.x >= bounds.left - 1e-7 && candidate.x + item.width <= bounds.right + 1e-7);
    const fits = candidate => inBounds(candidate) && placed.every(other => !overlaps(candidate, other, gap));
    if (fits(origin)) {
      placed.push(origin);
      continue;
    }

    const xs = new Set([origin.x]);
    const ys = new Set([item.y]);
    if (bounds) {
      xs.add(bounds.left);
      xs.add(bounds.right - item.width);
    }
    for (const other of placed) {
      xs.add(other.x - item.width - gap);
      xs.add(other.x + other.width + gap);
      ys.add(other.y - item.height - gap);
      ys.add(other.y + other.height + gap);
    }
    const candidates = [];
    for (const x of xs) {
      if (!inBounds({ x })) continue;
      for (const y of ys) {
        const dx = x - origin.x;
        const dy = y - item.y;
        candidates.push({ x, y, dx, dy, distance: dx * dx + dy * dy });
      }
    }
    candidates.sort((a, b) => a.distance - b.distance || Math.abs(a.dx) - Math.abs(b.dx) || a.dy - b.dy || a.dx - b.dx);
    const nearby = candidates.find(candidate => candidate.distance <= 80 * 80 && fits({ ...item, ...candidate }));
    const target = nearby ?? candidates.find(candidate => fits({ ...item, ...candidate }));
    // The outermost edge candidates are always available for finite rectangles.
    placed.push({ ...item, x: target.x, y: target.y });
  }
  return placed;
}

function overlaps(a, b, gap) {
  // Tolerate subpixel rounding where two calculated edges should meet exactly.
  const epsilon = 1e-7;
  return a.x < b.x + b.width + gap - epsilon &&
    a.x + a.width + gap > b.x + epsilon &&
    a.y < b.y + b.height + gap - epsilon &&
    a.y + a.height + gap > b.y + epsilon;
}
