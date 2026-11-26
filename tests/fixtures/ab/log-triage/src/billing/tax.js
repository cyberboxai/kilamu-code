export const DEFAULT_RATE = 0.14;
const RATES = { LDA: 0.14, BGU: 0.14, HUA: 0.14, CAB: 0.07 };

/** Tax in cents for an amount in cents. Unknown regions use DEFAULT_RATE (documented policy). */
export function taxFor(region, cents) {
  const rate = RATES[region] ?? DEFAULT_RATE;
  return Math.round(cents * rate);
}
