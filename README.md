# Stripe Transactions

A small local dashboard showing your latest Stripe payments and refunds — all products, top-ups and
subscriptions — with an optional "Tracked products" view for the products you choose.
No dependencies — just Node 18+.

## Setup

1. Create a **restricted key** in Stripe: Dashboard → Developers → API keys → *Create restricted key*.
   Give it **Read** access to: Checkout Sessions, Invoices, Products, Charges, Refunds,
   Payment Intents, Balance Transactions, Customers, Payouts, Balance (everything else: None).
2. `cp .env.example .env`, paste the key into `STRIPE_SECRET_KEY`, and set `DASHBOARD_USER` /
   `DASHBOARD_PASSWORD` — the browser will ask for these when you open the dashboard.
3. `npm start`, then open http://localhost:4242
4. Optional: click **Choose products** and tick the products for the "Tracked products" view
   (saved to `products.json`).

## Earnings, fees and payment details

- The top cards and the **Earnings report** show amounts in your payout currency after Stripe's
  fees (processing, currency conversion, VAT) and refunds, with a per-product breakdown and what's
  still pending. **Download CSV** exports every transaction in the current view with those figures.
- Click any transaction to open its details: activity timeline, checkout/invoice summary, payment
  breakdown (conversion rate, itemised fees, net, funds-available date), refunds, payment method,
  risk level and customer. Users only see details for payments within their scope.

## Payouts

**Payouts to your bank** shows what Stripe has already sent to your bank (with the payments in each
payout), the next payout date and estimated amount (funds available now plus funds that become
available before then), and the following cycle. Each transaction is tagged *Paid out <date>* or
*Next payout <date>*, and the CSV includes the payout columns. Users with a scope see their share of
each payout: only the payments they can see, without account-level fees.

## What counts as a transaction

- **Checkout / Payment Link** — completed one-time Checkout Sessions, including ones that create a
  product on the fly (e.g. "Balance Top-Up").
- **Subscription / Invoice** — paid invoices, using the amount actually collected (discounts and
  carried-over balances included). Invoices where nothing was collected (trials, credits) are skipped.
- **Failed / canceled** — unsuccessful payment attempts, listed greyed out and never counted in totals.
- **Other payments** — successful payments not linked to Checkout or an invoice (e.g. created via the API).
- **Refund** — each refund is its own negative row, and the original payment is marked
  *refunded* or *partially refunded*.

Payments created directly via the PaymentIntents API carry no product information, so they are
labelled with their description instead of a product name.

The key stays on the server (bound to 127.0.0.1); the browser only sees the filtered results.
# stripe-transactions

The dashboard and API are protected by a sign-in page (`DASHBOARD_USER` / `DASHBOARD_PASSWORD`).
Add more users with `_2`, `_3`, … suffixes. `DASHBOARD_SCOPE` limits what a user sees by product
name prefix — `only:Sentink Plus` shows just that group, `hide:Sentink Plus` shows everything else.
Scopes are enforced on the server, including refunds and the tracked-products list.
Sessions last 12 hours and 5 failed attempts lock an IP out for 15 minutes. If you ever host this
beyond localhost, put it behind HTTPS.
