// Stripe transactions dashboard — zero-dependency Node server.
// Keeps the Stripe key server-side and exposes a tiny JSON API to the dashboard page.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
loadEnv(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT || 4242);
const HOST = '127.0.0.1';
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const USERS = loadUsers();

if (!USERS.length) {
  console.error('DASHBOARD_USER and DASHBOARD_PASSWORD must be set in .env (see .env.example).');
  process.exit(1);
}
const STRIPE_API = process.env.STRIPE_API_BASE || 'https://api.stripe.com';
const PRODUCTS_FILE = path.join(ROOT, 'products.json');
const CACHE_MS = 60_000;
const MAX_PAGES = 10; // 100 objects per page per source

const cache = new Map(); // key -> { at, data }

// ---------- helpers ----------

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

// Users come from .env: DASHBOARD_USER / DASHBOARD_PASSWORD / DASHBOARD_SCOPE, then the same
// names with _2, _3, ... for more users. A scope limits which products a user can see:
//   only:<name prefix>  -> only products whose name starts with the prefix
//   hide:<name prefix>  -> everything except those products
//   (empty)             -> everything
function loadUsers() {
  const users = [];
  for (let i = 1; i <= 20; i++) {
    const sfx = i === 1 ? '' : `_${i}`;
    const name = process.env[`DASHBOARD_USER${sfx}`];
    const pass = process.env[`DASHBOARD_PASSWORD${sfx}`];
    if (!name || !pass) continue;
    // Hosting panels often keep surrounding quotes as part of the value; drop them.
    const raw = (process.env[`DASHBOARD_SCOPE${sfx}`] || '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
    const m = raw.match(/^(only|hide)\s*:\s*(.+)$/i);
    if (raw && !m) {
      // Fail closed: a typo here must never show a restricted user everything.
      console.error(`DASHBOARD_SCOPE${sfx} is set but not understood: expected "only:<name>" or "hide:<name>".`);
      process.exit(1);
    }
    users.push({ name, pass, scope: m ? { mode: m[1].toLowerCase(), prefix: m[2].trim().toLowerCase(), label: m[2].trim() } : null });
  }
  return users;
}

// Whether a user may see something sold under these product names.
function visible(user, productNames) {
  if (!user.scope) return true;
  const inGroup = productNames.some((n) => String(n || '').toLowerCase().startsWith(user.scope.prefix));
  return user.scope.mode === 'only' ? inGroup : !inGroup;
}

function scopeFor(user, data) {
  return {
    ...data,
    rows: data.rows.filter((r) => visible(user, r.product_names)),
    tracked: data.tracked.filter((p) => visible(user, [p.name])),
    user: { name: user.name, scope: user.scope && `${user.scope.mode === 'only' ? 'Only' : 'Excluding'} ${user.scope.label}` },
  };
}

function readProducts() {
  try {
    const ids = JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8'));
    return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && id.startsWith('prod_')) : [];
  } catch {
    return [];
  }
}

function writeProducts(ids) {
  fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(ids, null, 2) + '\n');
}

async function stripe(pathname, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((x) => qs.append(k, x));
    else if (v !== undefined) qs.append(k, String(v));
  }
  const res = await fetch(`${STRIPE_API}${pathname}?${qs}`, {
    headers: { Authorization: `Bearer ${STRIPE_KEY}` },
  });
  const body = await res.json();
  if (!res.ok) {
    const err = new Error(body?.error?.message || `Stripe error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

async function listAll(pathname, params) {
  const out = [];
  let starting_after;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await stripe(pathname, { limit: 100, ...params, starting_after });
    out.push(...res.data);
    if (!res.has_more || !res.data.length) break;
    starting_after = res.data[res.data.length - 1].id;
  }
  return out;
}

// Price.product may be a string or an expanded object; newer API versions put
// invoice line pricing under `pricing.price_details`.
function productOf(line) {
  const p = line.price?.product ?? line.pricing?.price_details?.product ?? line.plan?.product;
  return typeof p === 'string' ? p : p?.id;
}

const isTestKey = () => /^(sk|rk)_test_/.test(STRIPE_KEY);
const dashLink = (kind, id) => `https://dashboard.stripe.com/${isTestKey() ? 'test/' : ''}${kind}/${id}`;

// ---------- transactions ----------

const idOf = (v) => (typeof v === 'string' ? v : v?.id);

// Spread what an invoice actually collected across its lines in proportion to their
// list amounts, so discounts, taxes and carried-over balances are reflected. Integer
// cents; the last line absorbs rounding so the parts add up exactly.
function splitPaid(paid, lineAmounts) {
  const total = lineAmounts.reduce((n, a) => n + a, 0);
  if (!lineAmounts.length) return [];
  if (!total) return lineAmounts.map((_, i) => (i === 0 ? paid : 0));
  const parts = lineAmounts.map((a) => Math.round((a / total) * paid));
  parts[parts.length - 1] += paid - parts.reduce((n, a) => n + a, 0);
  return parts;
}

// Payout-currency figures from a balance transaction (optionally a share of it).
function settlement(bt, part) {
  if (!bt || typeof bt !== 'object') return {};
  return {
    settle_currency: bt.currency,
    settle_gross: part ? part.gross : bt.amount,
    fee: part ? part.fee : bt.fee,
    net: part ? part.net : bt.net,
    exchange_rate: bt.exchange_rate || null,
    available_on: bt.available_on,
    funds_status: bt.status,
  };
}

function refundStatus(charge) {
  if (!charge || !charge.amount_refunded) return null;
  return charge.refunded ? 'refunded' : 'partially refunded';
}

async function getTransactions(days, force) {
  const productIds = readProducts();
  const key = `${days}|${productIds.join(',')}`;
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const tracked = new Set(productIds);
  const since = days ? Math.floor(Date.now() / 1000) - days * 86400 : 0; // 0 days = all time

  const [sessions, invoices, charges, refunds, intents, products] = await Promise.all([
    listAll('/v1/checkout/sessions', {
      status: 'complete',
      'created[gte]': since,
      'expand[]': ['data.line_items'],
    }),
    listAll('/v1/invoices', { 'created[gte]': since, 'expand[]': ['data.payments'] }),
    listAll('/v1/charges', { 'created[gte]': since, 'expand[]': ['data.balance_transaction'] }),
    listAll('/v1/refunds', { 'created[gte]': since, 'expand[]': ['data.balance_transaction'] }),
    listAll('/v1/payment_intents', { 'created[gte]': since }),
    listAll('/v1/products', {}),
  ]);

  // Products created inline at checkout (e.g. "Balance Top-Up") aren't in the catalog,
  // so fall back to the line item description for their name.
  const names = Object.fromEntries(products.map((p) => [p.id, p.name]));
  // A payment can have failed attempts before it succeeds; keep the successful charge.
  const chargeByPI = new Map();
  for (const c of charges) {
    const pi = idOf(c.payment_intent);
    if (!chargeByPI.has(pi) || c.status === 'succeeded') chargeByPI.set(pi, c);
  }
  const invoicePI = (inv) =>
    idOf(inv.payments?.data?.find((p) => p.payment?.payment_intent)?.payment?.payment_intent ?? inv.payment_intent);
  const invoiceByPI = new Map(invoices.map((inv) => [invoicePI(inv), inv]).filter(([pi]) => pi));
  const rows = [];
  const rowsByPI = new Map(); // payment_intent -> payment rows, used to label refunds
  const paymentCheckoutInvoices = new Set();

  const addPayment = (pi, row) => {
    const charge = pi && chargeByPI.get(pi);
    row.kind = 'payment';
    row.product_names = [row.product];
    row.payment_intent = pi || null;
    row.status = refundStatus(charge) || row.status;
    row.refunded_amount = charge?.amount_refunded || 0;
    row.tracked = tracked.has(row.product_id);
    rows.push(row);
    if (pi) rowsByPI.set(pi, [...(rowsByPI.get(pi) || []), row]);
  };

  // One-time payments made through Checkout / Payment Links (including top-ups).
  for (const s of sessions) {
    if (s.mode !== 'payment') continue; // subscriptions are counted via their invoices
    if (s.invoice) paymentCheckoutInvoices.add(idOf(s.invoice));
    const pi = idOf(s.payment_intent);
    for (const li of s.line_items?.data || []) {
      const pid = productOf(li);
      addPayment(pi, {
        id: `${s.id}:${li.id}`,
        created: s.created,
        product_id: pid,
        product: names[pid] || li.description || pid || 'Payment',
        quantity: li.quantity,
        amount: li.amount_total,
        currency: li.currency || s.currency,
        customer: s.customer_details?.email || s.customer_details?.name || '—',
        status: s.payment_status,
        source: s.payment_link ? 'Payment Link' : 'Checkout',
        url: pi ? dashLink('payments', pi) : dashLink('checkout/sessions', s.id),
      });
    }
  }

  // Subscription payments and invoiced charges (payment-mode Checkout invoices are skipped to avoid doubles).
  for (const inv of invoices) {
    if (inv.status !== 'paid' || paymentCheckoutInvoices.has(inv.id)) continue;
    if (!inv.amount_paid) continue; // trials, credits, amounts carried over: no money moved
    const pi = invoicePI(inv);
    const lines = inv.lines?.data || [];
    const paid = splitPaid(inv.amount_paid, lines.map((li) => li.amount));
    lines.forEach((li, i) => {
      const pid = productOf(li);
      addPayment(pi, {
        id: `${inv.id}:${li.id}`,
        created: inv.status_transitions?.paid_at || inv.created,
        product_id: pid,
        product: names[pid] || li.description || pid || 'Invoice',
        quantity: li.quantity,
        amount: paid[i],
        currency: li.currency || inv.currency,
        customer: inv.customer_email || inv.customer_name || '—',
        status: 'paid',
        source: inv.subscription || inv.parent?.subscription_details ? 'Subscription' : 'Invoice',
        invoice: inv.id,
        url: dashLink('invoices', inv.id),
      });
    });
  }

  // Product/customer for a payment we have no row for: its invoice if we fetched it,
  // otherwise the Checkout Session that created it.
  const describePI = async (pi) => {
    const inv = invoiceByPI.get(pi);
    if (inv) {
      return (inv.lines?.data || []).map((li) => ({
        product_id: productOf(li),
        product: names[productOf(li)] || li.description,
        customer: inv.customer_email || inv.customer_name || '—',
      }));
    }
    const found = await stripe('/v1/checkout/sessions', { payment_intent: pi, 'expand[]': ['data.line_items'] })
      .then((res) => res.data[0]).catch(() => null);
    return (found?.line_items?.data || []).map((li) => ({
      product_id: productOf(li),
      product: names[productOf(li)] || li.description,
      customer: found.customer_details?.email || found.customer_details?.name || '—',
    }));
  };

  // Payments not tied to a paid Checkout Session or invoice: direct API payments
  // (counted like any payment) and failed/canceled attempts (listed, not counted).
  for (const p of intents) {
    if (rowsByPI.has(p.id) || p.status === 'requires_capture') continue;
    const ok = p.status === 'succeeded';
    if (!ok && !p.last_payment_error && p.status !== 'canceled') continue; // abandoned before any attempt
    const originals = await describePI(p.id);
    const first = originals[0] || {};
    const row = {
      id: p.id,
      created: p.created,
      product_id: first.product_id,
      product: [...new Set(originals.map((o) => o.product))].join(', ') || p.description || 'Payment',
      quantity: null,
      amount: p.amount_received || p.amount,
      currency: p.currency,
      customer: first.customer || p.receipt_email || '—',
      status: ok ? 'paid' : p.status === 'canceled' ? 'canceled' : 'failed',
      source: invoiceByPI.has(p.id) ? 'Subscription' : 'Payment',
      url: dashLink('payments', p.id),
    };
    if (ok) {
      addPayment(p.id, row);
    } else {
      rows.push({
        ...row, kind: 'failed', refunded_amount: 0, payment_intent: p.id,
        product_names: originals.length ? originals.map((o) => o.product) : [row.product],
        tracked: originals.some((o) => tracked.has(o.product_id)),
      });
    }
  }

  // Refunds as their own (negative) rows. If the original payment is older than the
  // date range, look up its Checkout Session so the refund still shows a product.
  for (const r of refunds) {
    const pi = idOf(r.payment_intent);
    let originals = (pi && rowsByPI.get(pi)) || [];
    if (!originals.length && pi) originals = await describePI(pi);
    const first = originals[0] || {};
    rows.push({
      id: r.id,
      kind: 'refund',
      created: r.created,
      product_id: first.product_id,
      product: [...new Set(originals.map((o) => o.product))].join(', ') || 'Refund',
      quantity: null,
      amount: -r.amount,
      currency: r.currency,
      customer: first.customer || '—',
      status: r.status === 'succeeded' ? 'refund' : `refund ${r.status}`,
      source: 'Refund',
      tracked: originals.some((o) => tracked.has(o.product_id)),
      product_names: originals.length ? originals.map((o) => o.product) : ['Refund'],
      payment_intent: pi || null,
      source_id: r.id,
      ...settlement(r.balance_transaction, null),
      url: pi ? dashLink('payments', pi) : dashLink('refunds', r.id),
    });
  }

  // What each payment is worth in the payout currency after Stripe's fees. A payment
  // split over several lines shares its fee and net in proportion to the line amounts.
  for (const [pi, list] of rowsByPI) {
    const bt = chargeByPI.get(pi)?.balance_transaction;
    if (!bt || typeof bt !== 'object') continue;
    const weights = list.map((r) => r.amount);
    const gross = splitPaid(bt.amount, weights), fee = splitPaid(bt.fee, weights), net = splitPaid(bt.net, weights);
    const chargeId = chargeByPI.get(pi).id;
    list.forEach((r, i) => Object.assign(r, settlement(bt, { gross: gross[i], fee: fee[i], net: net[i] }), { source_id: chargeId }));
  }

  rows.sort((a, b) => b.created - a.created);
  const data = {
    rows,
    tracked: productIds.map((id) => ({ id, name: names[id] || id })),
    days,
    mode: isTestKey() ? 'test' : 'live',
    fetched_at: Date.now(),
    truncated: [sessions, invoices, charges, refunds, intents].some((list) => list.length >= MAX_PAGES * 100),
  };
  cache.set(key, { at: Date.now(), data });
  return data;
}

// ---------- exchange rates ----------

// Display-only conversion from the payout currency. Daily rates from open.er-api.com (free,
// no key), cached; if that's unreachable, fall back to the rates Stripe applied to this
// account's own conversions.
const RATES_MS = 6 * 60 * 60 * 1000;
const ratesCache = new Map(); // base -> { at, data }

async function getRates(base, rows) {
  const hit = ratesCache.get(base);
  if (hit && Date.now() - hit.at < RATES_MS) return hit.data;
  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${base.toUpperCase()}`, { signal: AbortSignal.timeout(5000) });
    const body = await res.json();
    if (body.result !== 'success') throw new Error('rates unavailable');
    const data = {
      base,
      rates: Object.fromEntries(Object.entries(body.rates).map(([c, r]) => [c.toLowerCase(), r])),
      source: 'open.er-api.com',
      updated: body.time_last_update_unix,
    };
    ratesCache.set(base, { at: Date.now(), data });
    return data;
  } catch {
    const rates = { [base]: 1 };
    for (const r of rows) {
      if (r.exchange_rate && r.settle_currency === base && r.currency !== base) rates[r.currency] = 1 / r.exchange_rate;
    }
    return { base, rates, source: 'stripe', updated: null };
  }
}

// ---------- payouts ----------

const PAYOUTS_MS = 10 * 60 * 1000;
let payoutCache = { at: 0, data: null };

// Every payout with the balance transactions it contained, plus the balance and schedule.
async function getPayoutData(force) {
  if (!force && payoutCache.data && Date.now() - payoutCache.at < PAYOUTS_MS) return payoutCache.data;
  const [payouts, balance, settings] = await Promise.all([
    listAll('/v1/payouts', { 'expand[]': ['data.destination'] }),
    stripe('/v1/balance'),
    stripe('/v1/account').then((a) => a.settings?.payouts?.schedule || null).catch(() => null),
  ]);
  const sourceToPayout = {};
  const contents = {}; // payout id -> balance transactions in it
  await Promise.all(payouts.filter((p) => p.automatic && p.status !== 'failed' && p.status !== 'canceled').map(async (p) => {
    const txns = await listAll('/v1/balance_transactions', { payout: p.id });
    contents[p.id] = txns.filter((t) => t.type !== 'payout');
    for (const t of contents[p.id]) if (t.source) sourceToPayout[idOf(t.source)] = p.id;
  }));
  const data = { payouts, balance, schedule: settings, sourceToPayout, contents };
  payoutCache = { at: Date.now(), data };
  return data;
}

// Next payout day (00:00 UTC) after `from`, per the account's schedule; null for manual payouts.
function nextPayoutDate(schedule, from) {
  if (!schedule || schedule.interval === 'manual') return null;
  const d = new Date(from * 1000);
  const at = (y, m, day) => Date.UTC(y, m, Math.min(day, new Date(Date.UTC(y, m + 1, 0)).getUTCDate())) / 1000;
  if (schedule.interval === 'monthly') {
    const days = schedule.monthly_payout_days || [schedule.monthly_anchor || 1];
    const candidates = [];
    for (let k = 0; k < 3; k++) for (const day of days) candidates.push(at(d.getUTCFullYear(), d.getUTCMonth() + k, day));
    return candidates.sort((a, b) => a - b).find((t) => t > from);
  }
  if (schedule.interval === 'weekly') {
    const names = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const wanted = (schedule.weekly_payout_days || [schedule.weekly_anchor || 'monday']).map((n) => names.indexOf(n));
    for (let k = 1; k <= 8; k++) {
      const t = at(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + k);
      if (wanted.includes(new Date(t * 1000).getUTCDay())) return t;
    }
  }
  return at(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); // daily
}

function scheduleText(s) {
  if (!s) return 'Payout schedule unknown';
  if (s.interval === 'manual') return 'Manual payouts';
  const ord = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : n % 10] || 'th');
  if (s.interval === 'monthly') return `Monthly on the ${(s.monthly_payout_days || [s.monthly_anchor]).map(ord).join(' & ')}`;
  if (s.interval === 'weekly') return `Weekly on ${(s.weekly_payout_days || [s.weekly_anchor]).map((d) => d[0].toUpperCase() + d.slice(1)).join(' & ')}`;
  return 'Daily';
}

// Payouts as one user sees them: their share of each payout, and what's still to come.
function payoutsFor(user, rows, pd) {
  const scoped = !!user.scope;
  const money = rows.filter((r) => r.kind !== 'failed' && r.net != null);
  const byPayout = {};
  const upcoming = [];
  for (const r of money) {
    const po = r.source_id && pd.sourceToPayout[r.source_id];
    if (po) (byPayout[po] = byPayout[po] || []).push(r);
    else upcoming.push(r);
  }
  const payouts = pd.payouts.map((p) => {
    const mine = byPayout[p.id] || [];
    const share = mine.reduce((n, r) => n + r.net, 0);
    const other = (pd.contents[p.id] || []).reduce((n, t) => n + t.net, 0) - share; // account fees, other products
    return {
      id: p.id, created: p.created, arrival_date: p.arrival_date, status: p.status, method: p.method,
      currency: p.currency,
      amount: scoped ? share : p.amount,
      bank_total: scoped ? null : p.amount,
      other: scoped ? null : other,
      payments: mine.filter((r) => r.kind === 'payment').length,
      refunds: mine.filter((r) => r.kind === 'refund').length,
      gross: mine.filter((r) => r.kind === 'payment').reduce((n, r) => n + r.settle_gross, 0),
      fees: mine.filter((r) => r.kind === 'payment').reduce((n, r) => n + r.fee, 0),
      refunded: -mine.filter((r) => r.kind === 'refund').reduce((n, r) => n + r.net, 0),
      bank: p.destination && typeof p.destination === 'object'
        ? { name: p.destination.bank_name || p.destination.brand || 'Bank', last4: p.destination.last4 } : null,
      items: mine.map((r) => ({ product: r.product, kind: r.kind, net: r.net, created: r.created, payment_intent: r.payment_intent })),
    };
  }).filter((p) => p.amount || !scoped).sort((a, b) => b.arrival_date - a.arrival_date);

  const now = Date.now() / 1000;
  const next = nextPayoutDate(pd.schedule, now);
  const after = next ? nextPayoutDate(pd.schedule, next) : null;
  const delayDays = pd.schedule?.delay_days || 0;
  // A payout on day D pays out funds that became available by D.
  const inNext = upcoming.filter((r) => !next || r.available_on <= next);
  const inLater = upcoming.filter((r) => next && r.available_on > next);
  const sum = (l) => l.reduce((n, r) => n + r.net, 0);
  const currency = pd.balance.available?.[0]?.currency || money[0]?.settle_currency || 'aed';
  const dest = pd.payouts.find((p) => p.destination && typeof p.destination === 'object')?.destination;
  const bank = dest ? { name: dest.bank_name || dest.brand || 'Bank', last4: dest.last4 } : null;

  return {
    currency,
    schedule: { text: scheduleText(pd.schedule), delay_days: delayDays, interval: pd.schedule?.interval || null },
    bank,
    paid_out: payouts.filter((p) => p.status === 'paid').reduce((n, p) => n + p.amount, 0),
    in_transit: payouts.filter((p) => p.status === 'in_transit' || p.status === 'pending').reduce((n, p) => n + p.amount, 0),
    next: next && {
      date: next,
      amount: sum(inNext),
      available_now: sum(inNext.filter((r) => r.available_on <= now)),
      becoming_available: sum(inNext.filter((r) => r.available_on > now)),
      count: inNext.length,
    },
    after: after && { date: after, amount: sum(inLater), count: inLater.length },
    // Account-wide balance only for users who can see everything.
    balance: scoped ? null : {
      available: pd.balance.available?.reduce((n, b) => n + (b.currency === currency ? b.amount : 0), 0) || 0,
      pending: pd.balance.pending?.reduce((n, b) => n + (b.currency === currency ? b.amount : 0), 0) || 0,
    },
    scoped,
    payouts,
  };
}

// ---------- payment details ----------

const FEE_LABELS = { stripe_fee: 'Stripe fee', application_fee: 'Application fee', tax: 'Tax on fees' };

// Everything Stripe's payment page shows, for one payment intent.
async function getPaymentDetail(pi, rows) {
  const [intent, chargeList, refundList, sessionList] = await Promise.all([
    stripe(`/v1/payment_intents/${pi}`, { 'expand[]': ['customer'] }),
    stripe('/v1/charges', { payment_intent: pi, limit: 20, 'expand[]': ['data.balance_transaction'] }),
    stripe('/v1/refunds', { payment_intent: pi, limit: 50, 'expand[]': ['data.balance_transaction'] }),
    stripe('/v1/checkout/sessions', { payment_intent: pi, limit: 1, 'expand[]': ['data.line_items'] }),
  ]);
  const charges = chargeList.data;
  const charge = charges.find((c) => c.status === 'succeeded') || charges[0] || null;
  const bt = charge && typeof charge.balance_transaction === 'object' ? charge.balance_transaction : null;
  const session = sessionList.data[0] || null;
  const invoiceId = rows.find((r) => r.invoice)?.invoice;
  const invoice = invoiceId ? await stripe(`/v1/invoices/${invoiceId}`).catch(() => null) : null;
  const refunds = refundList.data;
  const customerObj = intent.customer && typeof intent.customer === 'object' && !intent.customer.deleted ? intent.customer : null;

  // Items: from the Checkout Session, else the invoice, else a single line.
  let items = [], totals = null;
  if (session) {
    items = (session.line_items?.data || []).map((li) => ({
      name: li.description || li.price?.nickname || 'Item',
      quantity: li.quantity,
      unit_amount: li.price?.unit_amount ?? (li.quantity ? Math.round(li.amount_subtotal / li.quantity) : li.amount_subtotal),
      amount: li.amount_total,
      currency: li.currency,
    }));
    totals = {
      subtotal: session.amount_subtotal,
      discount: session.total_details?.amount_discount || 0,
      tax: session.total_details?.amount_tax || 0,
      shipping: session.total_details?.amount_shipping || 0,
      total: session.amount_total,
      currency: session.currency,
    };
  } else if (invoice) {
    items = (invoice.lines?.data || []).map((li) => ({
      name: li.description || 'Item',
      quantity: li.quantity,
      unit_amount: li.pricing?.unit_amount_decimal ? Math.round(Number(li.pricing.unit_amount_decimal)) : li.price?.unit_amount ?? null,
      amount: li.amount,
      currency: li.currency,
      period: li.period ? { start: li.period.start, end: li.period.end } : null,
    }));
    totals = {
      subtotal: invoice.subtotal,
      discount: (invoice.total_discount_amounts || []).reduce((n, d) => n + d.amount, 0),
      tax: (invoice.total_taxes || invoice.total_tax_amounts || []).reduce((n, t) => n + (t.amount || 0), 0),
      shipping: 0,
      credit: Math.max(0, invoice.total - invoice.amount_paid),
      total: invoice.total,
      paid: invoice.amount_paid,
      currency: invoice.currency,
    };
  } else {
    items = [{ name: rows[0]?.product || intent.description || 'Payment', quantity: 1, unit_amount: intent.amount, amount: intent.amount, currency: intent.currency }];
  }

  // Timeline, newest first (like Stripe's "Recent activity").
  const events = [{ at: intent.created, label: 'Payment started', tone: 'muted' }];
  for (const c of charges) {
    if (c.status === 'failed') {
      events.push({ at: c.created, label: 'Payment failed', detail: c.failure_message || c.outcome?.seller_message, tone: 'bad' });
    } else if (c.status === 'succeeded') {
      events.push({ at: c.created, label: c.captured ? 'Payment succeeded' : 'Payment authorized', detail: c.outcome?.seller_message, tone: 'good' });
    }
    if (c.disputed) events.push({ at: c.created, label: 'Payment disputed', tone: 'bad' });
  }
  if (invoice?.status_transitions?.paid_at) {
    // Stripe can stamp the invoice a second before the charge; it still follows the payment.
    const paidAt = Math.max(invoice.status_transitions.paid_at, charge?.created || 0);
    events.push({ at: paidAt, label: `Invoice ${invoice.number || ''} paid`.replace('  ', ' '), tone: 'good' });
  }
  for (const r of refunds) {
    events.push({ at: r.created, label: `Refunded ${fmtPlain(r.amount, r.currency)}`, detail: r.reason ? r.reason.replace(/_/g, ' ') : null, tone: 'bad' });
  }
  if (intent.status === 'canceled') events.push({ at: intent.canceled_at || intent.created, label: 'Payment canceled', detail: intent.cancellation_reason?.replace(/_/g, ' '), tone: 'muted' });
  if (bt?.available_on) {
    events.push({ at: bt.available_on, label: bt.available_on * 1000 > Date.now() ? 'Funds will be available' : 'Funds available', tone: 'muted', future: bt.available_on * 1000 > Date.now() });
  }
  // Newest first; events in the same second keep their logical order (started before succeeded).
  events.forEach((e, i) => { e.seq = i; });
  events.sort((a, b) => b.at - a.at || b.seq - a.seq);

  const card = charge?.payment_method_details?.card;
  const pmType = charge?.payment_method_details?.type;
  const refundedSettle = refunds.reduce((n, r) => n + (typeof r.balance_transaction === 'object' ? -r.balance_transaction.amount : 0), 0);
  const name = session?.customer_details?.name || customerObj?.name || charge?.billing_details?.name || invoice?.customer_name || null;
  const email = session?.customer_details?.email || customerObj?.email || charge?.billing_details?.email || invoice?.customer_email || intent.receipt_email || null;

  return {
    id: pi,
    amount: intent.amount_received || intent.amount,
    currency: intent.currency,
    status: charge?.refunded ? 'refunded' : charge?.amount_refunded ? 'partially refunded'
      : intent.status === 'succeeded' ? 'succeeded' : intent.status === 'canceled' ? 'canceled' : charges.some((c) => c.status === 'failed') ? 'failed' : intent.status,
    created: intent.created,
    updated: Math.max(intent.created, ...events.filter((e) => !e.future).map((e) => e.at)),
    product: rows[0]?.product,
    source: rows.find((r) => r.kind !== 'refund')?.source || (session ? 'Checkout' : invoice ? 'Subscription' : 'Payment'),
    description: intent.description || charge?.description || null,
    statement_descriptor: charge?.calculated_statement_descriptor || intent.statement_descriptor || null,
    receipt_url: charge?.receipt_url || null,
    stripe_url: dashLink('payments', pi),
    events,
    customer: {
      name, email,
      country: session?.customer_details?.address?.country || charge?.billing_details?.address?.country || card?.country || null,
      phone: session?.customer_details?.phone || charge?.billing_details?.phone || null,
      id: customerObj?.id || idOf(intent.customer) || null,
      guest: !intent.customer,
    },
    items, totals,
    breakdown: bt && {
      amount: charge.amount, currency: charge.currency,
      settle_amount: bt.amount, settle_currency: bt.currency,
      exchange_rate: bt.exchange_rate,
      fee: bt.fee,
      fees: bt.fee_details.map((f) => ({ label: f.description || FEE_LABELS[f.type] || f.type, amount: f.amount, currency: f.currency })),
      net: bt.net,
      refunded: refundedSettle,
      net_after_refunds: bt.net - refundedSettle,
      available_on: bt.available_on,
      funds_status: bt.status,
    },
    refunds: refunds.map((r) => ({
      id: r.id, amount: r.amount, currency: r.currency, created: r.created, status: r.status,
      reason: r.reason ? r.reason.replace(/_/g, ' ') : null,
      settle_amount: typeof r.balance_transaction === 'object' ? -r.balance_transaction.amount : null,
      settle_currency: typeof r.balance_transaction === 'object' ? r.balance_transaction.currency : null,
    })),
    method: charge ? {
      type: pmType,
      brand: card?.brand || null, last4: card?.last4 || null,
      exp: card ? `${String(card.exp_month).padStart(2, '0')}/${card.exp_year}` : null,
      funding: card?.funding || null, country: card?.country || null,
      wallet: card?.wallet?.type || null, network: card?.network || null,
      three_d_secure: card?.three_d_secure?.result || null,
      checks: card?.checks ? { cvc: card.checks.cvc_check, address: card.checks.address_line1_check, zip: card.checks.address_postal_code_check } : null,
    } : null,
    risk: charge?.outcome ? {
      level: charge.outcome.risk_level, score: charge.outcome.risk_score ?? null,
      network_status: charge.outcome.network_status, message: charge.outcome.seller_message,
    } : null,
    ids: {
      payment_intent: pi, charge: charge?.id || null, balance_transaction: bt?.id || null,
      checkout_session: session?.id || null, invoice: invoice?.id || null,
      invoice_number: invoice?.number || null, subscription: invoice?.parent?.subscription_details?.subscription || null,
    },
    links: {
      invoice: invoice ? dashLink('invoices', invoice.id) : null,
      hosted_invoice: invoice?.hosted_invoice_url || null,
      customer: customerObj ? dashLink('customers', customerObj.id) : null,
    },
  };
}

const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);
function fmtPlain(amount, currency) {
  const div = ZERO_DECIMAL.has(currency) ? 1 : 100;
  return `${(amount / div).toFixed(div === 1 ? 0 : 2)} ${currency.toUpperCase()}`;
}

// ---------- http ----------

// Compare via SHA-256 digests so timingSafeEqual gets equal-length inputs and
// response time doesn't leak how much of the value matched.
function safeEqual(a, b) {
  const h = (v) => crypto.createHash('sha256').update(v).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

// Returns the matching user or null. Checks every user and both fields so timing
// doesn't reveal which usernames exist.
function checkCredentials(name, pass) {
  let match = null;
  for (const u of USERS) {
    const userOk = safeEqual(name, u.name);
    const passOk = safeEqual(pass, u.pass);
    if (userOk && passOk && !match) match = u;
  }
  return match;
}

// ----- sessions (in memory: restarting the server signs everyone out) -----

const SESSION_COOKIE = 'sid';
const SESSION_MS = 12 * 60 * 60 * 1000;
const sessions = new Map(); // token -> { exp, user }

function getCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}

// The signed-in user for this request, or null.
function sessionUser(req) {
  const token = getCookie(req, SESSION_COOKIE);
  const s = token && sessions.get(token);
  if (!s) return null;
  if (s.exp < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return s.user;
}

function cookieHeader(req, value, maxAgeSec) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}${secure}`;
}

// ----- brute-force protection: 5 failures per IP locks that IP out for 15 minutes -----

const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const failures = new Map(); // ip -> { count, first }

function lockedOut(ip) {
  const f = failures.get(ip);
  if (!f) return false;
  if (Date.now() - f.first > LOCKOUT_MS) {
    failures.delete(ip);
    return false;
  }
  return f.count >= MAX_FAILURES;
}

function recordFailure(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.first > LOCKOUT_MS) failures.set(ip, { count: 1, first: Date.now() });
  else f.count++;
}

function loginPage(error = '') {
  const html = fs.readFileSync(path.join(ROOT, 'public/login.html'), 'utf8');
  return html.replace('{{ERROR}}', error ? `<p class="error" role="alert">${error}</p>` : '');
}

function redirect(res, location, headers = {}) {
  res.writeHead(303, { Location: location, 'Cache-Control': 'no-store', ...headers });
  res.end();
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e5) req.destroy();
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/login' && req.method === 'GET') {
      if (sessionUser(req)) return redirect(res, '/');
      return send(res, 200, loginPage(), 'text/html; charset=utf-8');
    }
    if (url.pathname === '/login' && req.method === 'POST') {
      const ip = req.socket.remoteAddress;
      if (lockedOut(ip)) {
        return send(res, 429, loginPage('Too many failed attempts. Try again in 15 minutes.'), 'text/html; charset=utf-8');
      }
      const form = new URLSearchParams(await readBody(req));
      const user = checkCredentials(form.get('username') || '', form.get('password') || '');
      if (!user) {
        recordFailure(ip);
        return send(res, 401, loginPage('Incorrect username or password.'), 'text/html; charset=utf-8');
      }
      failures.delete(ip);
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, { exp: Date.now() + SESSION_MS, user });
      return redirect(res, '/', { 'Set-Cookie': cookieHeader(req, token, SESSION_MS / 1000) });
    }
    if (url.pathname === '/logout' && req.method === 'POST') {
      sessions.delete(getCookie(req, SESSION_COOKIE));
      return redirect(res, '/login', { 'Set-Cookie': cookieHeader(req, '', 0) });
    }
    const user = sessionUser(req);
    if (!user) {
      if (url.pathname.startsWith('/api/')) return send(res, 401, { error: 'Not signed in' });
      return redirect(res, '/login');
    }

    if (url.pathname === '/' && req.method === 'GET') {
      return send(res, 200, fs.readFileSync(path.join(ROOT, 'public/index.html')), 'text/html; charset=utf-8');
    }
    if (!STRIPE_KEY && url.pathname.startsWith('/api/')) {
      return send(res, 500, { error: 'STRIPE_SECRET_KEY is not set. Copy .env.example to .env and add your key.' });
    }
    if (url.pathname === '/api/transactions' && req.method === 'GET') {
      const raw = url.searchParams.get('days');
      const days = raw === 'all' ? 0 : Math.min(Math.max(Number(raw) || 30, 1), 365);
      const scoped = scopeFor(user, await getTransactions(days, url.searchParams.has('refresh')));
      const counts = {};
      for (const r of scoped.rows) if (r.settle_currency) counts[r.settle_currency] = (counts[r.settle_currency] || 0) + 1;
      const base = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || 'aed';
      scoped.rates = await getRates(base, scoped.rows);
      // Which payout each transaction went out in (or that it's still to come).
      const pd = await getPayoutData(false).catch(() => null);
      if (pd) {
        const byId = new Map(pd.payouts.map((p) => [p.id, p]));
        const next = nextPayoutDate(pd.schedule, Date.now() / 1000);
        for (const r of scoped.rows) {
          if (r.kind === 'failed' || r.net == null) continue;
          const p = r.source_id && byId.get(pd.sourceToPayout[r.source_id]);
          r.payout = p ? { id: p.id, date: p.arrival_date, status: p.status }
            : { id: null, date: next && r.available_on <= next ? next : null, status: 'upcoming' };
        }
      }
      return send(res, 200, scoped);
    }
    if (url.pathname === '/api/payouts' && req.method === 'GET') {
      const force = url.searchParams.has('refresh');
      const [rows, pd] = await Promise.all([getTransactions(0, force).then((d) => scopeFor(user, d).rows), getPayoutData(force)]);
      return send(res, 200, payoutsFor(user, rows, pd));
    }
    const detail = url.pathname.match(/^\/api\/payments\/(pi_[A-Za-z0-9]+)$/);
    if (detail && req.method === 'GET') {
      // Only payments this user can see in the dashboard (all time) can be opened.
      const visibleRows = scopeFor(user, await getTransactions(0, false)).rows.filter((r) => r.payment_intent === detail[1]);
      if (!visibleRows.length) return send(res, 404, { error: 'Payment not found' });
      return send(res, 200, await getPaymentDetail(detail[1], visibleRows));
    }
    if (url.pathname === '/api/catalog' && req.method === 'GET') {
      const all = await listAll('/v1/products', { active: true });
      const products = all.filter((p) => visible(user, [p.name])).map((p) => ({ id: p.id, name: p.name }));
      const allowed = new Set(products.map((p) => p.id));
      return send(res, 200, { products, selected: readProducts().filter((id) => allowed.has(id)) });
    }
    if (url.pathname === '/api/products' && req.method === 'PUT') {
      const ids = JSON.parse(await readBody(req));
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && /^prod_\w+$/.test(id))) {
        return send(res, 400, { error: 'Expected an array of product IDs (prod_...)' });
      }
      // Only change the user's own slice of the tracked list; keep products they can't see.
      const all = await listAll('/v1/products', {});
      const allowed = new Set(all.filter((p) => visible(user, [p.name])).map((p) => p.id));
      if (ids.some((id) => !allowed.has(id))) return send(res, 403, { error: 'Not allowed to track that product' });
      writeProducts([...readProducts().filter((id) => !allowed.has(id)), ...ids]);
      cache.clear();
      return send(res, 200, { ok: true, selected: ids });
    }
    send(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    send(res, err.status === 401 ? 401 : 502, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
  for (const u of USERS) {
    console.log(`  user "${u.name}": ${u.scope ? `${u.scope.mode === 'only' ? 'only' : 'everything except'} products starting with "${u.scope.label}"` : 'all products'}`);
  }
  if (!STRIPE_KEY) console.warn('Warning: STRIPE_SECRET_KEY is not set (see .env.example).');
});
