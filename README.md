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

## Sync with Money Master

Sign in as **sentink** and open **Sync with Money Master**. The feature is restricted to this
user (`MONEY_MASTER_USER`) and always excludes products starting with **Sentink Plus**. It targets
**login center 12**. Dashboard date, tracked-product, and search filters do not limit the sync;
the preview reads the complete Stripe history and follows pagination, including invoice and
Checkout line items. Review existing manually entered Stripe journals before the initial backfill;
only entries created through this bridge have duplicate-detection receipts.

1. Review each product's income ledger, then select **Save mappings & preview**. Suggestions use
   plan names and map sampling/top-up products to **Sampling Pre Paid**. A paid Starter, Growth
   or Pro subscription debits that plan's receivable and credits its income. The payout credits
   the receivable and debits Wio Bank. A suggestion is only saved when you press this button;
   unknown products remain unmapped until selected.
2. Expand preview entries to inspect their debit and credit lines. Already synced journals are
   skipped. Unmapped payments and unreconciled payouts appear under items needing review.
3. Select **Sync ready entries** to import the reviewed entries as **Pending** (`approved = 0`).
   Approve them separately in Money Master's Pending journal view. The preview lasts ten minutes.
   If the connection fails midway, create a fresh preview and sync again. Money Master stores
   each receipt in the same database transaction as its journal, so completed entries are skipped
   even after restarting either application. Fully deleted journals whose original records are
   otherwise unchanged appear as **Restore deleted** in the preview. Syncing explicitly restores
   those same records as Pending before importing dependent refunds/payouts. Customer-memo and
   pending-policy upgrades appear as **Update memo · Pending** and only update unchanged journals'
   memos/workflow state; amounts, ledgers, dates and row IDs are preserved. Partially deleted,
   edited, rejected, missing or duplicated journals remain conflicts and are never overwritten.
   A later manual approval does not cause another import or reset on an unchanged retry.

The ledger mapping comes from the supplied `ac_ledgers.sql` and `ac_chart_of_accounts.sql`
exports, using only active login-center-12 ledgers:

| Purpose | Account | Ledger |
| --- | --- | --- |
| Stripe receivables | 523 | 31758052 |
| Wio Bank | 522 | 31758060 |
| Stripe fees / Payment gateways share | 538 | 31758096 |
| Starter, Growth, Teams, Pro, Enterprise income | 528 | 31758077–31758081 |
| Starter, Growth and Pro receivables | 523 | 31758191–31758193 |
| Sampling Pre Paid / Post Paid income | 529 | 31758082 / 31758084 |

Checkout and sampling payments **debit Stripe receivables and credit income** at gross value in
Stripe's actual settlement currency. A paid **subscription** invoice for Starter, Growth or Pro
**debits that plan's receivable and credits its income** — income is the invoiced work, and the
receivable is its opposite. The paid payout then **debits Wio Bank and Stripe fees and credits
the plan receivable**. Teams and Enterprise subscriptions need a matching receivable ledger
before they can sync. The refund policy keeps the original payment and creates an opposite
journal for each **successful** refund. A full refund cancels the original income exactly;
partial refunds reverse only the refunded portion, allocated cumulatively so a series of partial
refunds leaves no rounding remainder when it reaches the full amount. An exchange-rate
difference between the original payment and refund is recorded in Stripe share while receivables
use the refund's actual Stripe settlement. Pending/failed refunds are not recognised as completed.
Refunds refer to the original charge and depend on earlier refunds for that charge.

Payment and refund memos include the customer's **name and email**, using Checkout/invoice or
charge snapshots, with the Stripe Customer record filling missing fields when available. Missing
details are labelled `not provided`. Payout memos list customers from the included payments;
very large lists show an overflow count. Details are kept server-side until shown to the
authorised Sentink dashboard user.

Only **paid** payouts **debit Wio Bank and Stripe fees and credit the receivable** that the
original invoice posted: the plan receivable for Starter, Growth and Pro, and Stripe receivables
for other payments. For a payout containing both Sentink and Plus, only the Sentink share is
posted to Wio Bank and fees. The
full payout must reconcile first. Fees are recognised on payout, as requested; unpayouted
receivables therefore remain at gross value. Posting dates use Asia/Dubai, matching Money Master.
For a batch containing only Sentink payments/refunds, separate Stripe Billing/FX fees and
taxes on Stripe fees are included in the Stripe share ledger at their complete net cost.
This includes VAT carried in a service fee transaction's `fee` field without counting it twice.
See [Stripe balance transaction types](https://docs.stripe.com/reports/balance-transaction-types).

Manual/instant payouts, disputes, unknown account-level adjustments, mixed-product charges crossing
the Sentink/Plus boundary, multiple-payment invoices, and missing settlement data require manual
review. These are never guessed or proportionally assigned. Stripe documents that the payout
filter is available only for automatic payouts:
[Stripe balance transaction API](https://docs.stripe.com/api/balance_transactions/list),
[payout reconciliation](https://docs.stripe.com/reports/payout-reconciliation).
Mixed Sentink/Plus payout batches with shared service fees also require manual allocation.

### One-time server setup

The companion Money Master changes are in the adjacent `accountant` project:

- Deploy `v2/api/stripe_sync.php` beside Money Master's existing `connect.php`.
- Apply `v2/api/migrations/stripe_sync.sql` to the Money Master database. The journal and receipt
  tables must use InnoDB; the bridge checks this before writing. Preview does not create tables.
- Configure these environment variables in the **Money Master PHP server**:
  - `STRIPE_SYNC_TOKEN`: a random secret of at least 32 characters.
  - `STRIPE_SYNC_CREATED_BY=68`: the active Money Master user recorded as journal creator.
  - `STRIPE_SYNC_CURRENCY=aed`: must match the ledger's accounting currency and Stripe settlements.
  - `STRIPE_SYNC_ALLOW_TEST=0`: keep test payments out of the live ledger. Only enable on a test database.
- On shared hosting without environment-variable controls, place a private
  `stripe_sync_config.php` beside the bridge instead. Use `stripe_sync_config.example.php` as
  the template. Environment variables take priority when set. The real config is git-ignored;
  keep its token private and identical to the Stripe server's `MONEY_MASTER_SYNC_TOKEN`.
- Ensure PHP receives the `Authorization` header from the web server. The bridge authenticates
  with the shared token before opening a database connection. The Stripe server also sends
  `X-Money-Master-Sync-Token` for hosts that strip `Authorization`; either header must contain
  the same secret. Money Master's environment can use `MONEY_MASTER_SYNC_TOKEN` as an alias
  for `STRIPE_SYNC_TOKEN`. An existing `STRIPE_SYNC_TOKEN` setting takes priority over that
  alias and the private config file.
- Set `MONEY_MASTER_USER=sentink`, `MONEY_MASTER_CURRENCY=aed`,
  `MONEY_MASTER_SYNC_URL=https://money-master.app/v2/api/stripe_sync.php`, and
  `MONEY_MASTER_SYNC_TOKEN` in the **Stripe server's environment**, then restart the server.
  Use the same secret on both servers. Keep it out of source control and browser code.

Both currency settings currently assume a two-decimal currency such as AED. The bridge validates
the login center, active ledgers, account IDs, creator, dependencies and balanced integer amounts
before saving a Pending journal. The dashboard requires bridge journal version 2 and pending-entry
support before it will enable syncing. Updating the PHP bridge requires no additional database
migration beyond the existing sync-receipt table. Mapping choices are stored in the git-ignored
`money-master-mappings.json`; back up that file with your server configuration.

`npm test` covers settlement amounts, rounding, refunds, scoped payouts, blocked cases,
authentication, pagination beyond 1,000 objects, receipt conflicts, and safe retry after a
partial failure using local mock Stripe and bridge servers. It also exercises the actual PHP
bridge with a test database adapter to check balanced inserts, rollback, duplicate receipts and
deleted-journal conflicts. The bridge still needs verification against a configured MariaDB
test database before enabling live posting.
