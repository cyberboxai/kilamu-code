/** Map a database row to the domain model. */
export function orderFromRow(row) {
  return { id: row.id, accountId: row.account_id, totalCents: row.total_cents, status: row.status };
}
