Implement four independent features for the shop backend. Each one has its own module and its own test file in test/. They do not depend on each other.

1. **Discount codes** (`src/pricing/discounts.js`). `applyDiscount(cart, code, now)` supports percentage codes and fixed-amount codes. It enforces expiry, minimum subtotal and single use per customer. See `test/discounts.test.js`.
2. **Loyalty points** (`src/loyalty/points.js`). Earn points per order, redeem them, and expire points older than 12 months, oldest first. See `test/points.test.js`.
3. **CSV export** (`src/export/csv.js`). `ordersToCsv(orders)` produces RFC 4180 CSV: quoting, escaped quotes, CRLF line endings and a stable column order. See `test/csv.test.js`.
4. **Audit log** (`src/audit/log.js`). An append-only log of field changes with actor and timestamp. It diffs objects and queries by entity. See `test/audit.test.js`.

The stubs currently throw "not implemented". Shared helpers are in `src/money.js`. Every test must pass.
