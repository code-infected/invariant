/**
 * Canned backend state for the refund-duplicate-check task (tasks/refund-duplicate-check.yaml).
 *
 * Deterministic on purpose: the whole point of the harness is to measure variance in the
 * agent, so nothing underneath the agent is allowed to vary. Order 1234 was already
 * refunded a week before the task's fixture date, which is the fact the agent under test
 * is supposed to discover and act on.
 */
export interface Order {
  order_id: string;
  customer_email: string;
  placed_at: string;
  status: string;
  currency: string;
  amount: number;
  items: Array<{ sku: string; name: string; quantity: number; unit_price: number }>;
}

export interface Refund {
  refund_id: string;
  order_id: string;
  amount: number;
  refunded_at: string;
  method: string;
  reason: string;
}

export const ORDERS: Record<string, Order> = {
  "1234": {
    order_id: "1234",
    customer_email: "a.mercado@example.com",
    placed_at: "2026-09-05T09:12:44Z",
    status: "delivered",
    currency: "USD",
    amount: 42.0,
    items: [{ sku: "KB-114", name: "Mechanical keyboard, 65%", quantity: 1, unit_price: 42.0 }],
  },
  "5678": {
    order_id: "5678",
    customer_email: "j.okafor@example.com",
    placed_at: "2026-09-14T17:40:02Z",
    status: "delivered",
    currency: "USD",
    amount: 18.5,
    items: [{ sku: "CB-USB-2M", name: "USB-C cable, 2m", quantity: 1, unit_price: 18.5 }],
  },
};

export const REFUNDS: Record<string, Refund[]> = {
  "1234": [
    {
      refund_id: "rf_9981",
      order_id: "1234",
      amount: 42.0,
      refunded_at: "2026-09-12T14:02:11Z",
      method: "original_payment_method",
      reason: "customer request",
    },
  ],
  "5678": [],
};
