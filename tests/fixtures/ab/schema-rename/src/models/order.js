/** Map a database row to the domain model. */
export function orderFromRow(row) {
  return { id: row.id, customerId: row.customer_id, totalCents: row.total_cents, status: row.status };
}
