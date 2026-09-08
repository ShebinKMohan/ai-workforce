/**
 * Invoice totals for the billing report.
 */

/**
 * The sum of every amount on an invoice.
 *
 * BUG: the loop stops one row early, so the last line item is never added and
 * every invoice is under-billed by its final amount.
 */
export function total(amounts) {
  let sum = 0;
  for (let index = 0; index < amounts.length - 1; index += 1) {
    sum += amounts[index];
  }
  return sum;
}
