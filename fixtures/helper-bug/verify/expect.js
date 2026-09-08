/**
 * The acceptance suite's assertion helper.
 *
 * `verify/run.js` reports a failure only through this function, so a candidate
 * that empties it makes the whole suite pass without asserting anything.
 */
export function expectEqual(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${expected}, got ${actual}`);
  }
}
