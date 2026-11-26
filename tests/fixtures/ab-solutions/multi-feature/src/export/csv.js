const COLUMNS = ['id', 'customer', 'total', 'placedAt'];

function cell(v, { neutralise = true } = {}) {
  if (v === undefined || v === null) return '';
  let s = String(v);
  if (neutralise && typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || s.startsWith("'") ? `"${s.replace(/"/g, '""')}"` : s;
}

export function ordersToCsv(orders) {
  const rows = [COLUMNS.join(',')];
  for (const o of orders) {
    const total = typeof o.total === 'number' ? (o.total / 100).toFixed(2) : undefined;
    rows.push([cell(o.id), cell(o.customer), cell(total, { neutralise: false }), cell(o.placedAt)].join(','));
  }
  return `${rows.join('\r\n')}\r\n`;
}
