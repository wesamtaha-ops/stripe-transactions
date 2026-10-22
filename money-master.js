const crypto = require('node:crypto');

// Verified against the supplied login-center-12 exports. Deleted ledgers are excluded.
const LEDGERS = [
  { id: 31758052, account_id: 523, role: 'receivable', name: 'Stripe receivables' },
  { id: 31758060, account_id: 522, role: 'bank', name: 'Wio Bank' },
  { id: 31758096, account_id: 538, role: 'fee', name: 'Stripe — Payment gateways share' },
  ...['Starter', 'Growth', 'Teams', 'Pro', 'Enterprise'].map((name, i) =>
    ({ id: 31758077 + i, account_id: 528, role: 'income', name: `Income - ${name} Plan` })),
  { id: 31758082, account_id: 529, role: 'income', name: 'Income - Sampling Pre Paid' },
  { id: 31758084, account_id: 529, role: 'income', name: 'Income - Sampling Post Paid' },
];
const incomeIds = new Set(LEDGERS.filter((l) => l.role === 'income').map((l) => l.id));
const productKey = (row) => row.product_id || `name:${row.product}`;
const idOf = (value) => typeof value === 'string' ? value : value?.id;
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const issue = (id, message) => ({ id, message });
const JOURNAL_VERSION = 2;

function financialRecord(entry) {
  const { key, account, mode, type, source_id, login_center, date, currency } = entry;
  return { key, account, mode, type, source_id, login_center, date, currency,
    lines: entry.lines.map(({ account_id, ledger_id, debit, credit }) => ({ account_id, ledger_id, debit, credit })),
    dependencies: [...entry.dependencies].sort() };
}
const financialDigest = (entry) => digest(financialRecord(entry));

function canRebuildRefund(entry, receipt, entries) {
  if (entry.type !== 'refund' || !receipt.restorable || receipt.payload_version !== 1 || !receipt.financial_record) return false;
  const previous = { ...receipt.financial_record, lines: [] }, current = { ...financialRecord(entry), lines: [] };
  if (JSON.stringify(previous) !== JSON.stringify(current)) return false;
  const amount = (lines, ledger) => lines.filter((line) => line.ledger_id === ledger).reduce((n, line) => n + line.debit - line.credit, 0);
  if (amount(entry.lines, 31758052) >= 0 || amount(receipt.financial_record.lines, 31758052) !== amount(entry.lines, 31758052)) return false;
  const original = entries.find((candidate) => candidate.type === 'payment' && entry.dependencies.includes(candidate.key));
  if (!original) return false;
  return [...incomeIds].every((id) => amount(original.lines, id) + amount(entry.lines, id) === 0);
}

function customerMemo(rows) {
  const people = new Map();
  for (const row of rows) {
    const fallback = String(row.customer || '').trim();
    const email = Array.from(String(row.customer_email || (fallback.includes('@') ? fallback : '')).trim()).slice(0, 320).join('');
    const name = Array.from(String(row.customer_name || (fallback && !fallback.includes('@') && fallback !== '—' ? fallback : '')).trim()).slice(0, 400).join('');
    if (name || email) people.set(`${name}\n${email}`, `Name: ${name || 'not provided'}; Email: ${email || 'not provided'}`);
  }
  if (!people.size) return 'Name: not provided; Email: not provided';
  const values = [...people.values()].sort();
  let memo = '', included = 0;
  for (const value of values) {
    const next = memo ? `${memo} | ${value}` : value;
    if (Buffer.byteLength(next, 'utf8') > 5000) break;
    memo = next; included++;
  }
  return memo + (included < values.length ? ` | ${values.length - included} more customers in Stripe payout` : '');
}
function memoReason(reason, rows) {
  const memo = customerMemo(rows);
  const prefix = Array.from(reason).slice(0, 700).join('');
  return `${prefix} | ${memo}`;
}

function scale(total, numerator, denominator) {
  let n = BigInt(total) * BigInt(numerator), d = BigInt(denominator);
  if (d < 0n) { n = -n; d = -d; }
  let q = n / d, remainder = n % d;
  if (remainder < 0n) { q--; remainder += d; }
  return Number(q + (remainder * 2n >= d ? 1n : 0n));
}

function suggestion(row) {
  const name = String(row.product || '').toLowerCase();
  const plans = ['starter', 'growth', 'teams', 'pro', 'enterprise'];
  const plan = plans.findIndex((p) => new RegExp(`\\b${p}\\b`).test(name));
  if (plan >= 0 && !/sample|sampling|top.?up/i.test(name)) return 31758077 + plan;
  if (/sample|sampling|top[ -]?up/.test(name)) return /post[ -]?paid/.test(name) ? 31758084 : 31758082;
  return null;
}

function productsFor(rows, mappings) {
  const products = new Map();
  for (const row of rows.filter((r) => r.kind === 'payment')) {
    const key = productKey(row);
    if (!products.has(key)) products.set(key, { key, name: row.product, ledger_id: mappings[key] || null, suggested_ledger_id: suggestion(row) });
  }
  return [...products.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Integer allocation, including negative proration lines. The final nonzero line
// absorbs rounding; each charge/refund always balances to its Stripe settlement.
function allocate(total, weights) {
  const sum = weights.reduce((n, v) => n + v, 0);
  if (!weights.length || !sum) throw new Error('Cannot allocate a zero-total payment');
  const parts = weights.map((w) => scale(total, w, sum));
  let last = parts.length - 1;
  while (weights[last] === 0) last--;
  parts[last] += total - parts.reduce((n, v) => n + v, 0);
  return parts;
}

function line(ledgerId, signedDebit) {
  const ledger = LEDGERS.find((l) => l.id === ledgerId);
  return { account_id: ledger.account_id, ledger_id: ledgerId, name: ledger.name, debit: Math.max(signedDebit, 0), credit: Math.max(-signedDebit, 0) };
}

function journal({ account, mode, type, id, timestamp, currency, lines, reason, dependencies = [] }) {
  const nonzero = lines.filter((l) => l.debit || l.credit);
  if (nonzero.reduce((n, l) => n + l.debit - l.credit, 0) !== 0) throw new Error(`Unbalanced journal: ${id}`);
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = Object.fromEntries(date.formatToParts(new Date(timestamp * 1000)).map((p) => [p.type, p.value]));
  return {
    key: `${account}:${mode}:${type}:${id}`, account, mode, type, source_id: id, login_center: 12,
    date: `${parts.year}-${parts.month}-${parts.day}`, currency, reason, version: JOURNAL_VERSION, approval: 'pending',
    lines: nonzero, dependencies,
  };
}

function buildPlan({ allRows, visibleRows, payouts, contents, mappings, account, mode, currency = 'aed', scopeKey }) {
  const entries = [], issues = [], skipped = [];
  const selected = new Set(visibleRows.map((r) => r.id));
  const payments = new Map(), sources = new Map(), keys = new Map();
  for (const row of allRows) {
    if (row.kind === 'payment' && row.source_id) payments.set(row.source_id, [...(payments.get(row.source_id) || []), row]);
    if (row.source_id) sources.set(row.source_id, [...(sources.get(row.source_id) || []), row]);
  }
  const addIssue = (id, message) => issues.push(issue(id, message));
  const create = (data) => journal({ account, mode, currency, ...data });

  for (const [source, rows] of payments) {
    if (!rows.some((r) => selected.has(r.id))) continue;
    if (rows.some((r) => !selected.has(r.id))) { addIssue(source, 'This charge mixes Sentink and excluded products. Review it manually.'); continue; }
    if (rows.some((r) => !['paid', 'no_payment_required', 'refunded', 'partially_refunded'].includes(r.status))) continue;
    if (rows.some((r) => r.settle_currency !== currency || !Number.isSafeInteger(r.settle_gross))) {
      addIssue(source, `Missing settlement amounts or settlement currency differs from ${currency.toUpperCase()}.`); continue;
    }
    if (rows.some((r) => !incomeIds.has(mappings[productKey(r)]))) { addIssue(source, 'Choose an income ledger for every product in this payment.'); continue; }
    const amounts = new Map();
    rows.forEach((r) => amounts.set(mappings[productKey(r)], (amounts.get(mappings[productKey(r)]) || 0) + r.settle_gross));
    const gross = rows.reduce((n, r) => n + r.settle_gross, 0);
    const entry = create({ type: 'payment', id: source, timestamp: rows[0].created,
      reason: memoReason(`Stripe payment ${source} — ${[...new Set(rows.map((r) => r.product))].join(', ')}`, rows),
      lines: [line(31758052, gross), ...[...amounts].sort(([a], [b]) => a - b).map(([id, amount]) => line(id, -amount))] });
    entries.push(entry); keys.set(source, entry.key);
  }
  const refundState = new Map();
  const blockedRefunds = new Set();
  const orderedRows = [...visibleRows].sort((a, b) => a.created - b.created || String(a.source_id || a.id).localeCompare(String(b.source_id || b.id)));
  for (const row of orderedRows) {
    if (row.kind === 'failed') { skipped.push(issue(row.id, 'Unsuccessful payment')); continue; }
    if (row.kind === 'payment' && !row.source_id && row.amount) addIssue(row.id, 'No Stripe charge settlement found.');
    if (row.kind !== 'refund' || row.status !== 'refund') continue;
    const originals = row.original_charge ? payments.get(row.original_charge) || [] : allRows.filter((r) => r.kind === 'payment' && r.payment_intent && r.payment_intent === row.payment_intent);
    const source = originals[0]?.source_id;
    if (!source || !keys.has(source) || originals.some((r) => !selected.has(r.id))) { addIssue(row.id, 'Original payment must be available, mapped and entirely within Sentink.'); continue; }
    if (blockedRefunds.has(source)) { addIssue(row.id, 'Resolve the earlier refund for this payment before syncing subsequent refunds.'); continue; }
    if (row.settle_currency !== currency || !Number.isSafeInteger(row.settle_gross) || row.settle_gross >= 0) { addIssue(row.id, 'Refund settlement is missing or has a different currency.'); blockedRefunds.add(source); continue; }
    const paidOriginal = originals.reduce((n, r) => n + r.amount, 0);
    const previous = refundState.get(source) || { refunded: 0, allocations: [] };
    if (!Number.isSafeInteger(paidOriginal) || paidOriginal <= 0 || !Number.isSafeInteger(row.amount) || row.amount >= 0 || row.currency !== originals[0].currency || originals.some((r) => r.currency !== row.currency) || previous.refunded - row.amount > paidOriginal) {
      addIssue(row.id, 'Refund amount/currency cannot be reconciled with the original payment.'); blockedRefunds.add(source); continue;
    }
    const income = new Map();
    originals.forEach((r) => income.set(mappings[productKey(r)], (income.get(mappings[productKey(r)]) || 0) + r.settle_gross));
    const ledgerAmounts = [...income].sort(([a], [b]) => a - b);
    const gross = ledgerAmounts.reduce((n, [, value]) => n + value, 0);
    const refunded = previous.refunded - row.amount;
    // Allocate cumulative refunds, then take the increment. Multiple partial
    // refunds therefore cancel the original ledger amounts exactly at 100%.
    const cumulative = allocate(scale(gross, refunded, paidOriginal), ledgerAmounts.map(([, amount]) => amount));
    const shares = cumulative.map((value, i) => value - (previous.allocations[i] || 0));
    const reversal = shares.reduce((n, value) => n + value, 0);
    const settlementAdjustment = -row.settle_gross - reversal;
    const entry = create({ type: 'refund', id: row.source_id, timestamp: row.created,
      reason: memoReason(`Stripe refund ${row.source_id} — reversal of ${source}${settlementAdjustment ? '; exchange difference in Stripe share' : ''}`, [...originals, row]),
      lines: [line(31758052, row.settle_gross), ...ledgerAmounts.map(([id], i) => line(id, shares[i])), ...(settlementAdjustment ? [line(31758096, settlementAdjustment)] : [])],
      dependencies: [...new Set([keys.get(source), ...(previous.key ? [previous.key] : [])])].sort() });
    refundState.set(source, { refunded, allocations: cumulative, key: entry.key });
    entries.push(entry); keys.set(row.source_id, entry.key);
  }

  for (const payout of payouts) {
    if (payout.status !== 'paid') { skipped.push(issue(payout.id, `Payout ${payout.status}; only paid payouts are posted.`)); continue; }
    if (!payout.automatic) { addIssue(payout.id, 'Manual/instant payout: Stripe does not provide a transaction batch. Reconcile manually.'); continue; }
    const batch = contents[payout.id];
    if (!batch?.length) { addIssue(payout.id, 'Payout contents are missing.'); continue; }
    if (payout.currency !== currency || batch.some((t) => t.currency !== currency) || batch.reduce((n, t) => n + t.net, 0) !== payout.amount) {
      addIssue(payout.id, 'The complete payout does not reconcile to Stripe’s bank amount in the configured currency.'); continue;
    }
    const paymentTypes = new Set(['charge', 'payment', 'refund', 'payment_refund']);
    const feeTypes = new Set(['stripe_fee', 'stripe_fx_fee', 'tax_fee']);
    const movements = batch.filter((t) => paymentTypes.has(t.type));
    const serviceFees = batch.filter((t) => feeTypes.has(t.type));
    const unsupported = batch.filter((t) => !paymentTypes.has(t.type) && !feeTypes.has(t.type));
    if (unsupported.length) {
      addIssue(payout.id, `Payout includes balance activity requiring manual review: ${[...new Set(unsupported.map((t) => t.type))].join(', ')}.`); continue;
    }
    if (movements.some((t) => !sources.has(idOf(t.source)))) {
      addIssue(payout.id, 'Payout contains payments or refunds whose original transactions are unavailable.'); continue;
    }
    const included = movements.filter((t) => sources.get(idOf(t.source)).some((r) => selected.has(r.id)));
    if (!included.length) continue;
    // A wholly Sentink batch can include its Billing/FX fees and VAT exactly.
    // A mixed Sentink/Plus batch needs an explicit allocation for shared fees.
    if (serviceFees.length && included.length !== movements.length) {
      addIssue(payout.id, 'Payout mixes Sentink and excluded products with shared Stripe service fees. Allocate these fees manually before syncing.'); continue;
    }
    if (included.some((t) => !keys.has(idOf(t.source)))) { addIssue(payout.id, 'Map and resolve every Sentink payment/refund in this payout first.'); continue; }
    if (included.some((t) => sources.get(idOf(t.source)).reduce((n, r) => n + r.settle_gross, 0) !== t.amount) || [...included, ...serviceFees].some((t) => ![t.amount, t.fee, t.net].every(Number.isSafeInteger) || t.amount - t.fee !== t.net)) {
      addIssue(payout.id, 'Payment/refund totals differ from the payout’s balance transactions.'); continue;
    }
    const gross = included.reduce((n, t) => n + t.amount, 0);
    // A service-fee transaction has a negative amount and may carry its own VAT
    // in `fee`. Its complete cost is -net, so VAT must not be counted twice.
    const serviceFeeNet = serviceFees.reduce((n, t) => n + t.net, 0);
    const fees = included.reduce((n, t) => n + t.fee, 0) - serviceFeeNet;
    const bank = included.reduce((n, t) => n + t.net, 0) + serviceFeeNet;
    entries.push(create({ type: 'payout', id: `${payout.id}_${scopeKey}`, timestamp: payout.arrival_date,
      reason: memoReason(`Stripe payout ${payout.id} — Sentink share; bank ${bank / 100} ${currency.toUpperCase()}`, included.flatMap((t) => sources.get(idOf(t.source)))),
      lines: [line(31758060, bank), line(31758096, fees), line(31758052, -gross)],
      dependencies: [...new Set(included.map((t) => keys.get(idOf(t.source))))].sort() }));
  }
  return { entries, issues, skipped };
}

function annotate(plan, receipts) {
  const receiptMap = new Map(receipts.map((r) => [r.entry_key, r]));
  const entries = plan.entries.map((entry) => {
    const hash = digest(entry), receipt = receiptMap.get(entry.key);
    let status = 'ready';
    if (receipt) {
      if (receipt.payload_hash === hash) status = receipt.intact ? 'synced' : receipt.restorable ? 'restore' : 'conflict';
      else status = receipt.financial_hash === financialDigest(entry) && (receipt.intact || receipt.restorable) ? 'update' : canRebuildRefund(entry, receipt, plan.entries) ? 'rebuild' : 'conflict';
    }
    return { ...entry, hash, status, ...(status === 'update' ? { upgrade_metadata: true, restore_deleted: Boolean(receipt.restorable) } : {}), ...(status === 'rebuild' ? { rebuild_deleted: true, previous_lines: receipt.financial_record.lines } : {}) };
  });
  // A payout/refund must not post when its original journal was changed/deleted.
  const blocked = new Set(entries.filter((e) => e.status === 'conflict').map((e) => e.key));
  for (const entry of entries) if (entry.dependencies.some((key) => blocked.has(key))) { entry.status = 'conflict'; blocked.add(entry.key); }
  return { ...plan, entries };
}

function createClient({ url, token, fetchImpl = fetch }) {
  const configured = Boolean(url && token);
  if (url) {
    const parsed = new URL(url);
    if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname)))) {
      throw new Error('MONEY_MASTER_SYNC_URL must use HTTPS (HTTP is allowed only for localhost).');
    }
  }
  return {
    configured,
    async request(method, body) {
      if (!configured) throw new Error('Set MONEY_MASTER_SYNC_URL and MONEY_MASTER_SYNC_TOKEN on the Stripe server, and install the Money Master bridge.');
      const response = await fetchImpl(url, { method, redirect: 'error', signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${token}`, 'X-Money-Master-Sync-Token': token, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const result = await response.json().catch(() => { throw new Error('Money Master returned an invalid response. Check the bridge URL.'); });
      if (!response.ok || !result.ok) throw new Error(result.error || `Money Master request failed (${response.status}).`);
      return result;
    },
  };
}

module.exports = { LEDGERS, productKey, productsFor, buildPlan, annotate, createClient, digest, financialRecord, financialDigest, incomeIds, JOURNAL_VERSION };
