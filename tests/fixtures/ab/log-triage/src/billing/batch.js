import { parseAmount } from './parse.js';
import { taxFor } from './tax.js';

/** Process one nightly batch of upstream records. Refunds have negative amounts. */
export function processBatch(records) {
  let netCents = 0;
  let taxCents = 0;
  for (const r of records) {
    const cents = parseAmount(r.amount);
    netCents += cents;
    taxCents += taxFor(r.region, cents);
  }
  return { count: records.length, netCents, taxCents, grossCents: netCents + taxCents };
}
