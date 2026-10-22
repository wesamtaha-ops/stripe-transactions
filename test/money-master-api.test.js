const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { LEDGERS, digest, financialDigest, JOURNAL_VERSION } = require('../money-master');

async function listen(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
function json(res, value, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); }

test('authenticated API: complete history, scoped mappings, preview, partial failure and safe resume', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'stripe-mm-test-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const receipts = new Map();
  let failPayout = true, fullLinesRead = false, productsPaginated = false, bridgeVersion = JOURNAL_VERSION;
  const starter = { id: 'li_starter', description: 'Starter plan', amount_total: 10000, currency: 'usd', price: { product: 'prod_starter' } };
  const sample = { id: 'li_sample', description: 'Buying samples', amount_total: 20000, currency: 'usd', price: { product: 'prod_sample' } };
  const bt = { id: 'txn_one', amount: 30001, fee: 1001, net: 29000, currency: 'aed', available_on: 1780000000, status: 'available' };
  const btPlus = { ...bt, id: 'txn_plus', amount: 10000, fee: 300, net: 9700 };
  const products = Array.from({ length: 1000 }, (_, i) => ({ id: `prod_dummy${i}`, name: `Other ${i}` })).concat([
    { id: 'prod_starter', name: 'Sentink Starter' }, { id: 'prod_sample', name: 'Buying samples' }, { id: 'prod_plus', name: 'Sentink Plus' },
  ]);
  const data = {
    '/v1/checkout/sessions': [
      { id: 'cs_one', mode: 'payment', payment_intent: 'pi_one', payment_status: 'paid', customer: 'cus_fixture', customer_details: { email: 'jane@example.com' }, created: 1780000000, line_items: { has_more: true, data: [starter] } },
      { id: 'cs_plus', mode: 'payment', payment_intent: 'pi_plus', payment_status: 'paid', created: 1780000000, line_items: { data: [{ id: 'li_plus', amount_total: 10000, price: { product: 'prod_plus' } }] } },
    ],
    '/v1/invoices': [], '/v1/refunds': [{ id: 're_one', charge: 'ch_one', payment_intent: 'pi_one', amount: 30000, currency: 'usd', status: 'succeeded', created: 1780200000, balance_transaction: { id: 'txn_refund', amount: -30001, fee: 0, net: -30001, currency: 'aed' } }],
    '/v1/payment_intents': [{ id: 'pi_one', status: 'succeeded' }, { id: 'pi_plus', status: 'succeeded' }],
    '/v1/charges': [
      { id: 'ch_one', payment_intent: 'pi_one', status: 'succeeded', refunded: true, amount_refunded: 30000, customer: 'cus_fixture', balance_transaction: bt },
      { id: 'ch_plus', payment_intent: 'pi_plus', status: 'succeeded', balance_transaction: btPlus },
    ],
    '/v1/products': products,
    '/v1/payouts': [{ id: 'po_one', status: 'paid', automatic: true, amount: 28193, currency: 'aed', arrival_date: 1780100000 }],
    '/v1/balance_transactions': [{ ...bt, type: 'charge', source: 'ch_one' }, { id: 'txn_billing', type: 'stripe_fee', amount: -769, fee: 38, net: -807, currency: 'aed' }],
  };
  const stripe = await listen((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/v1/account') return json(res, { id: 'acct_fixture', settings: {} });
    if (url.pathname === '/v1/balance') return json(res, { available: [], pending: [] });
    if (url.pathname === '/v1/customers/cus_fixture') return json(res, { id: 'cus_fixture', name: 'Jane Buyer', email: 'jane@example.com' });
    let items = data[url.pathname];
    if (url.pathname === '/v1/checkout/sessions/cs_one/line_items') { fullLinesRead = true; items = [starter, sample]; }
    if (!items) return json(res, { error: { message: `Unexpected Stripe URL ${url.pathname}` } }, 404);
    const cursor = url.searchParams.get('starting_after');
    const start = cursor ? items.findIndex((i) => i.id === cursor) + 1 : 0;
    if (url.pathname === '/v1/products' && start >= 1000) productsPaginated = true;
    const page = items.slice(start, start + 100);
    json(res, { data: page, has_more: start + 100 < items.length });
  });
  t.after(() => stripe.server.close());
  const bridge = await listen(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer fixture-token-at-least-32-characters');
    if (req.method === 'GET') return json(res, { ok: true, login_center: 12, currency: 'aed', journal_version: bridgeVersion, pending_entries: bridgeVersion === JOURNAL_VERSION, allow_test: false, ledgers: LEDGERS, receipts: [...receipts.values()] });
    let raw = ''; for await (const chunk of req) raw += chunk;
    const entry = JSON.parse(JSON.parse(raw).payload);
    assert.equal(entry.approval, 'pending');
    if (entry.type === 'payout' && failPayout) { failPayout = false; return json(res, { ok: false, error: 'Simulated bridge outage' }, 503); }
    const wasRestored = JSON.parse(raw).restore_deleted === true;
    const wasUpdated = JSON.parse(raw).upgrade_metadata === true;
    receipts.set(entry.key, { entry_key: entry.key, payload_hash: digest(entry), financial_hash: financialDigest(entry), intact: true });
    json(res, { ok: true, status: wasRestored ? 'restored' : wasUpdated ? 'updated' : 'posted' });
  });
  t.after(() => bridge.server.close());
  for (const file of ['server.js', 'money-master.js']) await fs.copyFile(path.join(__dirname, '..', file), path.join(temporary, file));
  await fs.mkdir(path.join(temporary, 'public'));
  await fs.copyFile(path.join(__dirname, '..', 'public/login.html'), path.join(temporary, 'public/login.html'));
  const child = spawn(process.execPath, [path.join(temporary, 'server.js')], { env: { ...process.env, PORT: '0', STRIPE_SECRET_KEY: 'rk_live_fixture', STRIPE_API_BASE: stripe.url,
    DASHBOARD_USER: 'admin', DASHBOARD_PASSWORD: 'fixture-admin', DASHBOARD_SCOPE: 'only:Sentink Plus',
    DASHBOARD_USER_2: 'sentink', DASHBOARD_PASSWORD_2: 'fixture-sentink', DASHBOARD_SCOPE_2: 'hide:Sentink Plus',
    MONEY_MASTER_USER: 'sentink', MONEY_MASTER_SYNC_URL: bridge.url, MONEY_MASTER_SYNC_TOKEN: 'fixture-token-at-least-32-characters' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  // PORT=0 allocates an available port. Read it from the actual listen address.
  let startup = '';
  const output = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => { startup += chunk; const match = startup.match(/Dashboard running at (http:\/\/127\.0\.0\.1:\d+)/); if (match) resolve(match[1]); });
    child.once('error', reject); child.once('exit', (code) => reject(new Error(`Dashboard exited: ${code}`)));
  });
  const url = await output;
  const login = async (username, password) => {
    const response = await fetch(`${url}/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ username, password }) });
    assert.equal(response.status, 303);
    return response.headers.get('set-cookie').split(';')[0];
  };
  const admin = await login('admin', 'fixture-admin'), cookie = await login('sentink', 'fixture-sentink');
  const api = async (route, body, extra = {}) => {
    const response = await fetch(`${url}/api/money-master${route}`, { headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await fetch(`${url}/api/money-master`)).status, 401);
  assert.equal((await api('', undefined, { Cookie: admin })).status, 403);
  assert.equal((await api('/preview', {}, { Origin: 'https://untrusted.example' })).status, 403);
  const config = await api('');
  assert.equal(config.status, 200);
  assert.deepEqual(config.body.products.map((p) => p.name).sort(), ['Buying samples', 'Sentink Starter']);
  assert.equal(fullLinesRead, true); assert.equal(productsPaginated, true);
  assert.equal((await api('/mappings', { prod_plus: 31758077 })).status, 403);
  assert.equal((await api('/mappings', { prod_starter: 31758077, prod_sample: 31758082 })).status, 200);
  bridgeVersion = 1;
  const legacyBridge = await api('/preview', {});
  assert.equal(legacyBridge.body.connected, false);
  assert.match(legacyBridge.body.connection_error, /pending journals/);
  assert.equal((await api('/sync', { token: legacyBridge.body.token })).status, 409, 'an old bridge cannot auto-approve imports');
  assert.equal(receipts.size, 0);
  bridgeVersion = JOURNAL_VERSION;
  const preview = await api('/preview', {});
  assert.equal(preview.body.connected, true);
  assert.equal(preview.body.issues.length, 0);
  assert.equal(preview.body.entries.length, 3);
  assert.ok(preview.body.entries.every(entry => entry.approval === 'pending'));
  assert.ok(preview.body.entries.every(entry => entry.reason.includes('Jane Buyer') && entry.reason.includes('jane@example.com')));
  const payment = preview.body.entries.find(entry => entry.type === 'payment');
  const refund = preview.body.entries.find(entry => entry.type === 'refund');
  for (const line of payment.lines) {
    const opposite = refund.lines.find(other => other.ledger_id === line.ledger_id);
    assert.equal(opposite.debit, line.credit); assert.equal(opposite.credit, line.debit);
  }
  assert.equal(preview.body.entries.find((e) => e.type === 'payout').lines.find((l) => l.ledger_id === 31758060).debit, 28193);
  assert.equal(preview.body.entries.find((e) => e.type === 'payout').lines.find((l) => l.ledger_id === 31758096).debit, 1808);
  assert.equal((await api('/sync', { token: 'invented' })).status, 409);
  const partial = await api('/sync', { token: preview.body.token });
  assert.equal(partial.status, 502); assert.equal(partial.body.posted, 2);
  assert.equal(receipts.size, 2);
  const retry = await api('/preview', {});
  assert.deepEqual(retry.body.entries.map((e) => e.status), ['synced', 'synced', 'ready']);
  const resumed = await api('/sync', { token: retry.body.token });
  assert.equal(resumed.status, 200); assert.equal(resumed.body.posted, 1);
  assert.equal(receipts.size, 3);
  assert.equal((await api('/sync', { token: retry.body.token })).status, 409);
  const complete = await api('/preview', {});
  assert.ok(complete.body.entries.every((e) => e.status === 'synced'));
  receipts.values().next().value.intact = false;
  const conflict = await api('/preview', {});
  assert.ok(conflict.body.entries.every((e) => e.status === 'conflict'));
  receipts.values().next().value.restorable = true;
  const restore = await api('/preview', {});
  assert.deepEqual(restore.body.entries.map((e) => e.status), ['restore', 'synced', 'synced']);
  const restored = await api('/sync', { token: restore.body.token });
  assert.equal(restored.body.restored, 1); assert.equal(restored.body.posted, 0);
  assert.equal(receipts.size, 3);
});
