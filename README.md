# Stripe Transactions

A small local dashboard showing your latest Stripe payments and refunds — all products, top-ups and
subscriptions — with an optional "Tracked products" view for the products you choose.
No dependencies — just Node 18+.

## Setup

1. Create a **restricted key** in Stripe: Dashboard → Developers → API keys → *Create restricted key*.
   Give it **Read** access to: Checkout Sessions, Invoices, Products, Charges, Refunds (everything else: None).
2. `cp .env.example .env`, paste the key into `STRIPE_SECRET_KEY`, and set `DASHBOARD_USER` /
   `DASHBOARD_PASSWORD` — the browser will ask for these when you open the dashboard.
3. `npm start`, then open http://localhost:4242
4. Optional: click **Choose products** and tick the products for the "Tracked products" view
   (saved to `products.json`).

## What counts as a transaction

- **Checkout / Payment Link** — completed one-time Checkout Sessions, including ones that create a
  product on the fly (e.g. "Balance Top-Up").
- **Subscription / Invoice** — paid invoices, using the amount actually collected (discounts and
  carried-over balances included). Invoices where nothing was collected (trials, credits) are skipped.
- **Refund** — each refund is its own negative row, and the original payment is marked
  *refunded* or *partially refunded*.

Payments created directly via the PaymentIntents API without line items carry no product
information, so they can't be attributed to a product and are not shown.

The key stays on the server (bound to 127.0.0.1); the browser only sees the filtered results.
# stripe-transactions

The dashboard and API are protected by HTTP Basic auth. Basic auth sends the password with every
request, so if you ever host this beyond localhost, put it behind HTTPS.
