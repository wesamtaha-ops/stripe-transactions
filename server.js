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
const AUTH_USER = process.env.DASHBOARD_USER || '';
const AUTH_PASS = process.env.DASHBOARD_PASSWORD || '';

if (!AUTH_USER || !AUTH_PASS) {
  console.error('DASHBOARD_USER and DASHBOARD_PASSWORD must be set in .env (see .env.example).');
  process.exit(1);
}
const STRIPE_API = process.env.STRIPE_API_BASE || 'https://api.stripe.com';
const PRODUCTS_FILE = path.join(ROOT, 'products.json');
const CACHE_MS = 60_000;
const MAX_PAGES = 10; // 100 objects per page per source

let cache = { key: '', at: 0, data: null };

// ---------- helpers ----------

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
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

function refundStatus(charge) {
  if (!charge || !charge.amount_refunded) return null;
  return charge.refunded ? 'refunded' : 'partially refunded';
}

async function getTransactions(days, force) {
  const productIds = readProducts();
  const key = `${days}|${productIds.join(',')}`;
  if (!force && cache.data && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.data;

  const tracked = new Set(productIds);
  const since = Math.floor(Date.now() / 1000) - days * 86400;

  const [sessions, invoices, charges, refunds, products] = await Promise.all([
    listAll('/v1/checkout/sessions', {
      status: 'complete',
      'created[gte]': since,
      'expand[]': ['data.line_items'],
    }),
    listAll('/v1/invoices', { status: 'paid', 'created[gte]': since, 'expand[]': ['data.payments'] }),
    listAll('/v1/charges', { 'created[gte]': since }),
    listAll('/v1/refunds', { 'created[gte]': since }),
    listAll('/v1/products', {}),
  ]);

  // Products created inline at checkout (e.g. "Balance Top-Up") aren't in the catalog,
  // so fall back to the line item description for their name.
  const names = Object.fromEntries(products.map((p) => [p.id, p.name]));
  const chargeByPI = new Map(charges.map((c) => [idOf(c.payment_intent), c]));
  const rows = [];
  const rowsByPI = new Map(); // payment_intent -> payment rows, used to label refunds
  const paymentCheckoutInvoices = new Set();

  const addPayment = (pi, row) => {
    const charge = pi && chargeByPI.get(pi);
    row.kind = 'payment';
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
    if (paymentCheckoutInvoices.has(inv.id)) continue;
    if (!inv.amount_paid) continue; // trials, credits, amounts carried over: no money moved
    const pi = idOf(inv.payments?.data?.find((p) => p.payment?.payment_intent)?.payment?.payment_intent ?? inv.payment_intent);
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
        url: dashLink('invoices', inv.id),
      });
    });
  }

  // Refunds as their own (negative) rows. If the original payment is older than the
  // date range, look up its Checkout Session so the refund still shows a product.
  for (const r of refunds) {
    const pi = idOf(r.payment_intent);
    let originals = (pi && rowsByPI.get(pi)) || [];
    if (!originals.length && pi) {
      const found = await stripe('/v1/checkout/sessions', { payment_intent: pi, 'expand[]': ['data.line_items'] })
        .then((res) => res.data[0]).catch(() => null);
      originals = (found?.line_items?.data || []).map((li) => ({
        product_id: productOf(li),
        product: names[productOf(li)] || li.description,
        customer: found.customer_details?.email || found.customer_details?.name || '—',
      }));
    }
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
      url: pi ? dashLink('payments', pi) : dashLink('refunds', r.id),
    });
  }

  rows.sort((a, b) => b.created - a.created);
  const data = {
    rows,
    tracked: productIds.map((id) => ({ id, name: names[id] || id })),
    days,
    mode: isTestKey() ? 'test' : 'live',
    fetched_at: Date.now(),
    truncated: [sessions, invoices, charges, refunds].some((list) => list.length >= MAX_PAGES * 100),
  };
  cache = { key, at: Date.now(), data };
  return data;
}

// ---------- http ----------

// Compare via SHA-256 digests so timingSafeEqual gets equal-length inputs and
// response time doesn't leak how much of the value matched.
function safeEqual(a, b) {
  const h = (v) => crypto.createHash('sha256').update(v).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

function checkCredentials(user, pass) {
  // Evaluate both so a wrong username takes as long as a wrong password.
  const userOk = safeEqual(user, AUTH_USER);
  const passOk = safeEqual(pass, AUTH_PASS);
  return userOk && passOk;
}

// ----- sessions (in memory: restarting the server signs everyone out) -----

const SESSION_COOKIE = 'sid';
const SESSION_MS = 12 * 60 * 60 * 1000;
const sessions = new Map(); // token -> expiry timestamp

function getCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}

function hasSession(req) {
  const token = getCookie(req, SESSION_COOKIE);
  const exp = token && sessions.get(token);
  if (!exp) return false;
  if (exp < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
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
      if (hasSession(req)) return redirect(res, '/');
      return send(res, 200, loginPage(), 'text/html; charset=utf-8');
    }
    if (url.pathname === '/login' && req.method === 'POST') {
      const ip = req.socket.remoteAddress;
      if (lockedOut(ip)) {
        return send(res, 429, loginPage('Too many failed attempts. Try again in 15 minutes.'), 'text/html; charset=utf-8');
      }
      const form = new URLSearchParams(await readBody(req));
      if (!checkCredentials(form.get('username') || '', form.get('password') || '')) {
        recordFailure(ip);
        return send(res, 401, loginPage('Incorrect username or password.'), 'text/html; charset=utf-8');
      }
      failures.delete(ip);
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, Date.now() + SESSION_MS);
      return redirect(res, '/', { 'Set-Cookie': cookieHeader(req, token, SESSION_MS / 1000) });
    }
    if (url.pathname === '/logout' && req.method === 'POST') {
      sessions.delete(getCookie(req, SESSION_COOKIE));
      return redirect(res, '/login', { 'Set-Cookie': cookieHeader(req, '', 0) });
    }
    if (!hasSession(req)) {
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
      const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 30, 1), 365);
      return send(res, 200, await getTransactions(days, url.searchParams.has('refresh')));
    }
    if (url.pathname === '/api/catalog' && req.method === 'GET') {
      const all = await listAll('/v1/products', { active: true });
      return send(res, 200, { products: all.map((p) => ({ id: p.id, name: p.name })), selected: readProducts() });
    }
    if (url.pathname === '/api/products' && req.method === 'PUT') {
      const ids = JSON.parse(await readBody(req));
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && /^prod_\w+$/.test(id))) {
        return send(res, 400, { error: 'Expected an array of product IDs (prod_...)' });
      }
      writeProducts(ids);
      cache.data = null;
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
  if (!STRIPE_KEY) console.warn('Warning: STRIPE_SECRET_KEY is not set (see .env.example).');
});
