-- Initial schema for the customer app.
CREATE TABLE customers (
  customer_id SERIAL PRIMARY KEY,
  full_name   VARCHAR(200) NOT NULL,
  email       VARCHAR(320) NOT NULL UNIQUE,
  created_at  TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE "orders" (
  order_id    SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers (customer_id)
);

CREATE INDEX idx_orders_customer ON orders (customer_id);
