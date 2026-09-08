/**
 * The acceptance suite. Nothing about its path says "test": it is found
 * because `package.json` and `.workforce/checks.json` name it, and its helper
 * is found because this file imports it.
 */
import { expectEqual } from './expect.js';
import { total } from '../src/total.js';

expectEqual(total([1200, 340, 75]), 1615, 'every line item is billed');
expectEqual(total([500]), 500, 'a single line item is its own total');
expectEqual(total([]), 0, 'an empty invoice totals zero');

console.log('acceptance suite passed: 3 assertions');
