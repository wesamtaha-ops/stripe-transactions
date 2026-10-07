# Stripe Product Transactions

A small local dashboard showing the latest paid transactions for the Stripe products you choose.
No dependencies — just Node 18+.

## Setup

1. Create a **restricted key** in Stripe: Dashboard → Developers → API keys → *Create restricted key*.
   Give it **Read** access to: Checkout Sessions, Invoices, Products (everything else: None).
2. `cp .env.example .env` and paste the key into `STRIPE_SECRET_KEY`.
3. `npm start`, then open http://localhost:4242
4. Click **Choose products** and tick the products to track (saved to `products.json`).

## What counts as a transaction

- **Checkout** — completed one-time Checkout Sessions / Payment Links containing a tracked product.
- **Subscription / Invoice** — paid invoices with a line item for a tracked product (renewals included).

Payments created directly via the PaymentIntents API without line items carry no product
information, so they can't be attributed to a product and are not shown.

The key stays on the server (bound to 127.0.0.1); the browser only sees the filtered results.
# stripe-transactions
