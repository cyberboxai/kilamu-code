/** Convert a decimal amount string from the upstream export (e.g. "12.50") to integer cents. */
export function parseAmount(raw) {
  const n = Number.parseFloat(String(raw).trim());
  if (!Number.isFinite(n)) throw new TypeError(`invalid amount: ${raw}`);
  return Math.round(n * 100);
}
