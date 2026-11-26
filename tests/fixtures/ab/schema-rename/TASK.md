The `customer_id` concept is being renamed to `account_id` across the whole stack. Here is what changes:

- the `orders.customer_id` column in `db/schema.sql`;
- the model field `customerId`, which becomes `accountId`;
- the repository function `findOrdersByCustomer`, which becomes `findOrdersByAccount`;
- the API query parameter `customer`, which becomes `account`;
- the JSON key `customer_id`, which becomes `account_id`;
- the revenue report, which is grouped by account.

Behaviour must not change otherwise. No file under `db/` or `src/` may still mention `customer_id`, `customerId` or `Customer`. The tests in test/ define the expected result.
