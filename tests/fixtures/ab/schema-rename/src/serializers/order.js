/** Public JSON representation of an order. */
export function serializeOrder(order) {
  return { id: order.id, customer_id: order.customerId, total: order.totalCents / 100, status: order.status };
}
