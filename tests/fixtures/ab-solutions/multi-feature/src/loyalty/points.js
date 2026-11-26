const CENTS_PER_POINT = 10000;

export function createLedger() {
  return new Map();
}

const lots = (ledger, customer) => {
  if (!ledger.has(customer)) ledger.set(customer, []);
  return ledger.get(customer);
};

export function earn(ledger, customer, cents, at) {
  if (!Number.isInteger(cents) || cents < 0) throw new RangeError('cents must be a non-negative integer');
  const points = Math.floor(cents / CENTS_PER_POINT);
  if (points > 0) lots(ledger, customer).push({ at: new Date(at), remaining: points });
  return points;
}

export function balance(ledger, customer) {
  return (ledger.get(customer) ?? []).reduce((s, l) => s + l.remaining, 0);
}

export function redeem(ledger, customer, points, _at) {
  if (!Number.isInteger(points) || points <= 0) throw new RangeError('points must be a positive integer');
  const available = balance(ledger, customer);
  if (points > available) return { ok: false, reason: 'INSUFFICIENT_POINTS', available };
  let left = points;
  for (const lot of lots(ledger, customer).sort((a, b) => a.at - b.at)) {
    const take = Math.min(lot.remaining, left);
    lot.remaining -= take;
    left -= take;
    if (!left) break;
  }
  return { ok: true, remaining: available - points };
}

/** Expire every lot older than 12 months at `now`; returns the number of points expired. */
export function expire(ledger, now) {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 12);
  let expired = 0;
  for (const customerLots of ledger.values()) {
    for (const lot of customerLots) {
      if (lot.at < cutoff && lot.remaining > 0) {
        expired += lot.remaining;
        lot.remaining = 0;
      }
    }
  }
  return expired;
}
