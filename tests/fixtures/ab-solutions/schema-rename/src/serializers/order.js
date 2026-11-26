/** Public JSON representation of an order. */
export function serializeOrder(order) {
  return { id: order.id, account_id: order.accountId, total: order.totalCents / 100, status: order.status };
}
