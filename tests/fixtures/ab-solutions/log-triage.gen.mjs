// Deterministic generator for the log-triage A/B fixture data (test/nightly.json, test/expected.json, logs/*.log).
// Usage: node tests/fixtures/ab-solutions/log-triage.gen.mjs tests/fixtures/ab/log-triage
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.argv[2];
let a = 20261125;
const rand = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const regions = ['LDA', 'LDA', 'BGU', 'HUA', 'CAB', 'XK'];
const fmt = (cents) => {
  const neg = cents < 0; const abs = Math.abs(cents);
  const units = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${units}.${String(abs % 100).padStart(2, '0')}`;
};
const records = [];
for (let i = 1; i <= 400; i++) {
  const big = rand() < 0.3;
  let cents = big ? 100000 + Math.floor(rand() * 4_900_000) : 100 + Math.floor(rand() * 99_000);
  if (rand() < 0.05) cents = -Math.min(cents, 50_000);
  records.push({ id: `r-${String(i).padStart(4, '0')}`, region: pick(regions), amount: fmt(cents), cents });
}
const RATES = { LDA: 0.14, BGU: 0.14, HUA: 0.14, CAB: 0.07 };
let net = 0, tax = 0;
for (const r of records) { net += r.cents; tax += Math.round(r.cents * (RATES[r.region] ?? 0.14)); }
writeFileSync(join(dir, 'test', 'nightly.json'), JSON.stringify(records.map(({ cents, ...r }) => r), null, 1) + '\n');
writeFileSync(join(dir, 'test', 'expected.json'), JSON.stringify({ count: records.length, netCents: net, taxCents: tax, grossCents: net + tax }, null, 2) + '\n');
// Log: mostly noise, with red herrings and the real clue.
const lines = [];
let ms = Date.UTC(2026, 10, 25, 1, 0, 0);
const ts = () => { ms += 40 + Math.floor(rand() * 900); return new Date(ms).toISOString(); };
const noise = [
  () => `INFO  http: GET /health 200 ${1 + Math.floor(rand() * 9)}ms`,
  () => `INFO  scheduler: heartbeat worker=${pick(['w1', 'w2', 'w3'])} queue=${Math.floor(rand() * 40)}`,
  () => `DEBUG cache: hit key=rates:${pick(regions)} ttl=${Math.floor(rand() * 3600)}s`,
  () => `INFO  db: pool size=10 idle=${Math.floor(rand() * 10)} waiting=0`,
  () => `DEBUG auth: token refreshed service=ledger expires_in=3600`,
  () => `INFO  http: POST /internal/metrics 204 ${2 + Math.floor(rand() * 20)}ms`,
];
lines.push(`${ts()} INFO  billing: nightly batch started source=upstream-export-2026-11-25.csv records=400`);
let r = 0;
for (let i = 0; i < 4200; i++) {
  if (i % 10 === 5 && r < records.length) {
    const rec = records[r++];
    lines.push(`${ts()} DEBUG billing: record id=${rec.id} region=${rec.region} amount_raw="${rec.amount}" status=parsed`);
    if (rec.region === 'XK') lines.push(`${ts()} WARN  tax: unknown region "XK" record=${rec.id}; applying DEFAULT_RATE per policy BILL-112`);
    if (Math.abs(rec.cents) >= 100000 && rand() < 0.15) lines.push(`${ts()} WARN  ledger: reconciliation drift record=${rec.id} upstream_cents=${rec.cents} booked_cents=${Math.round(Number.parseFloat(rec.amount) * 100)}`);
    continue;
  }
  if (i === 1700) lines.push(`${ts()} WARN  db: slow query 2140ms SELECT * FROM fx_rates WHERE day = $1 (known, ticket OPS-77)`);
  if (i === 2900) lines.push(`${ts()} ERROR http: upstream timeout calling https://fx.example/rates (retry 1/3 succeeded)`);
  lines.push(`${ts()} ${pick(noise)()}`);
}
lines.push(`${ts()} INFO  billing: nightly batch finished records=400 status=ok`);
const booked = records.reduce((s, x) => s + Math.round(Number.parseFloat(x.amount) * 100), 0);
lines.push(`${ts()} WARN  finance: booked net ${booked} cents is ${(100 * (1 - booked / net)).toFixed(1)}% below the upstream control total ${net} cents (alert FIN-ALERT-3)`);
writeFileSync(join(dir, 'logs', 'nightly-2026-11-25.log'), lines.join('\n') + '\n');
console.log({ lines: lines.length, net, tax });
