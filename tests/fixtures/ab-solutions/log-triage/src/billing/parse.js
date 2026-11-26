/**
 * Convert a decimal amount string from the upstream export to integer cents.
 * The export uses "," as a thousands separator and "." as the decimal point (e.g. "1,234.50").
 */
export function parseAmount(raw) {
  const s = String(raw).trim();
  if (!/^-?\d{1,3}(,\d{3})*(\.\d{1,2})?$|^-?\d+(\.\d{1,2})?$/.test(s)) throw new TypeError(`invalid amount: ${raw}`);
  return Math.round(Number(s.replace(/,/g, '')) * 100);
}
