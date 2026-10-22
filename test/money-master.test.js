const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildPlan, annotate, productsFor, createClient, digest, financialDigest } = require('../money-master');

function payment(overrides = {}) {
  return { id: 'cs_one:li_one', kind: 'payment', source_id: 'ch_one', payment_intent: 'pi_one', product_id: 'prod_one', product: 'Sentink Starter', customer_name: 'Jane Buyer', customer_email: 'jane@example.com', amount: 10000, settle_gross: 36725, fee: 1200, net: 35525, settle_currency: 'aed', currency: 'usd', created: 1780000000, status: 'paid', ...overrides };
}
function plan(options = {}) {
  const row = payment();
  return buildPlan({ allRows: [row], visibleRows: [row], payouts: [], contents: {}, mappings: { prod_one: 31758077 }, account: 'acct_one', mode: 'live', currency: 'aed', scopeKey: 'scope', ...options });
}
function balance(entry) { return entry.lines.reduce((sum, l) => sum + l.debit - l.credit, 0); }
function amount(entry, ledger) { const l = entry.lines.find((l) => l.ledger_id === ledger); return l ? l.debit - l.credit : 0; }

test('payment recognises gross settlement in AED without expensing fees early', () => {
  const result = plan();
  assert.equal(result.issues.length, 0);
  assert.equal(amount(result.entries[0], 31758052), 36725);
  assert.equal(amount(result.entries[0], 31758077), -36725);
  assert.equal(amount(result.entries[0], 31758096), 0);
  assert.equal(balance(result.entries[0]), 0);
  assert.equal(result.entries[0].approval, 'pending');
  assert.match(result.entries[0].reason, /Jane Buyer/);
  assert.match(result.entries[0].reason, /jane@example\.com/);
});

test('subscription invoice debits the plan receivable and the payout credits it to the bank', () => {
  const row = payment({ source: 'Subscription', product: 'Sentink Starter' });
  const result = plan({ allRows: [row], visibleRows: [row],
    payouts: [{ id: 'po_sub', status: 'paid', automatic: true, amount: 35525, currency: 'aed', arrival_date: 1780100000 }],
    contents: { po_sub: [{ source: 'ch_one', type: 'charge', amount: 36725, fee: 1200, net: 35525, currency: 'aed' }] } });
  assert.equal(result.issues.length, 0);
  const charge = result.entries.find((entry) => entry.type === 'payment');
  const payout = result.entries.find((entry) => entry.type === 'payout');
  assert.equal(amount(charge, 31758191), 36725);
  assert.equal(amount(charge, 31758077), -36725);
  assert.equal(amount(charge, 31758052), 0);
  assert.equal(amount(payout, 31758060), 35525);
  assert.equal(amount(payout, 31758096), 1200);
  assert.equal(amount(payout, 31758191), -36725);
  assert.equal(amount(payout, 31758077), 0);
  assert.equal(amount(payout, 31758052), 0);
  assert.equal(balance(charge), 0);
  assert.equal(balance(payout), 0);
  assert.match(charge.reason, /invoiced to plan receivable/);
});

test('subscription refund reverses income and the payout clears the remaining receivable', () => {
  const row = payment({ source: 'Subscription', amount: 10000, currency: 'aed', settle_gross: 10000, fee: 300, net: 9700 });
  const refund = { id: 're_sub', source_id: 're_sub', original_charge: 'ch_one', kind: 'refund', status: 'refund', amount: -4000, currency: 'aed', settle_gross: -4000, settle_currency: 'aed', created: row.created + 10 };
  const result = plan({ allRows: [row, refund], visibleRows: [row, refund],
    payouts: [{ id: 'po_sub', status: 'paid', automatic: true, amount: 5700, currency: 'aed', arrival_date: 1780100000 }],
    contents: { po_sub: [
      { source: 'ch_one', type: 'charge', amount: 10000, fee: 300, net: 9700, currency: 'aed' },
      { source: 're_sub', type: 'refund', amount: -4000, fee: 0, net: -4000, currency: 'aed' },
    ] } });
  assert.equal(result.issues.length, 0);
  const reversal = result.entries.find((entry) => entry.type === 'refund');
  const payout = result.entries.find((entry) => entry.type === 'payout');
  assert.equal(amount(reversal, 31758077), 4000);
  assert.equal(amount(reversal, 31758191), -4000);
  assert.equal(amount(payout, 31758191), -6000);
  assert.equal(amount(payout, 31758077), 0);
  assert.equal(amount(payout, 31758052), 0);
  result.entries.forEach((entry) => assert.equal(balance(entry), 0));
  assert.equal(result.entries.reduce((sum, entry) => sum + amount(entry, 31758191), 0), 0);
  assert.equal(result.entries.reduce((sum, entry) => sum + amount(entry, 31758077), 0), -6000);
});

test('a refund after the payout debits income and the later payout returns the receivable against the bank', () => {
  const row = payment({ source: 'Subscription', amount: 10000, currency: 'aed', settle_gross: 10000, fee: 0, net: 10000 });
  const refund = { id: 're_later', source_id: 're_later', original_charge: 'ch_one', kind: 'refund', status: 'refund', amount: -4000, currency: 'aed', settle_gross: -4000, settle_currency: 'aed', created: row.created + 10 };
  const result = plan({ allRows: [row, refund], visibleRows: [row, refund],
    payouts: [
      { id: 'po_paid', status: 'paid', automatic: true, amount: 10000, currency: 'aed', arrival_date: 1780100000 },
      { id: 'po_refund', status: 'paid', automatic: true, amount: -4000, currency: 'aed', arrival_date: 1780200000 },
    ],
    contents: {
      po_paid: [{ source: 'ch_one', type: 'charge', amount: 10000, fee: 0, net: 10000, currency: 'aed' }],
      po_refund: [{ source: 're_later', type: 'refund', amount: -4000, fee: 0, net: -4000, currency: 'aed' }],
    } });
  assert.equal(result.issues.length, 0);
  const charge = result.entries.find((entry) => entry.type === 'payment');
  const reversal = result.entries.find((entry) => entry.type === 'refund');
  const first = result.entries.find((entry) => entry.source_id === 'po_paid_scope');
  const second = result.entries.find((entry) => entry.source_id === 'po_refund_scope');
  assert.equal(amount(charge, 31758191), 10000);
  assert.equal(amount(charge, 31758077), -10000);
  assert.equal(amount(first, 31758191), -10000);
  assert.equal(amount(first, 31758077), 0);
  assert.equal(amount(reversal, 31758077), 4000);
  assert.equal(amount(reversal, 31758191), -4000);
  assert.equal(amount(second, 31758191), 4000);
  assert.equal(amount(second, 31758060), -4000);
  assert.equal(result.entries.reduce((sum, entry) => sum + amount(entry, 31758077), 0), -6000);
  assert.equal(result.entries.reduce((sum, entry) => sum + amount(entry, 31758191), 0), 0);
  result.entries.forEach((entry) => assert.equal(balance(entry), 0));
});

test('sampling uses Stripe receivables while a subscription uses the plan receivable', () => {
  const subscription = payment({ source: 'Subscription', amount: 10000, currency: 'aed', settle_gross: 10000, fee: 300, net: 9700 });
  const sample = payment({ id: 'li_sample', source_id: 'ch_sample', product_id: 'prod_sample', product: 'Balance Top-Up', source: 'Checkout', amount: 5000, currency: 'aed', settle_gross: 5000, fee: 150, net: 4850 });
  const result = plan({ allRows: [subscription, sample], visibleRows: [subscription, sample], mappings: { prod_one: 31758077, prod_sample: 31758082 },
    payouts: [{ id: 'po_mix', status: 'paid', automatic: true, amount: 14550, currency: 'aed', arrival_date: 1780100000 }],
    contents: { po_mix: [
      { source: 'ch_one', type: 'charge', amount: 10000, fee: 300, net: 9700, currency: 'aed' },
      { source: 'ch_sample', type: 'charge', amount: 5000, fee: 150, net: 4850, currency: 'aed' },
    ] } });
  assert.equal(result.issues.length, 0);
  const samplePayment = result.entries.find((entry) => entry.source_id === 'ch_sample');
  const payout = result.entries.find((entry) => entry.type === 'payout');
  assert.equal(amount(samplePayment, 31758052), 5000);
  assert.equal(amount(samplePayment, 31758082), -5000);
  assert.equal(amount(payout, 31758052), -5000);
  assert.equal(amount(payout, 31758191), -10000);
  assert.equal(amount(payout, 31758077), 0);
  assert.equal(amount(payout, 31758082), 0);
  assert.equal(balance(payout), 0);
});

test('Teams and Enterprise subscriptions use Stripe receivables and their payout posts', () => {
  for (const incomeId of [31758079, 31758081]) {
    const row = payment({ source: 'Subscription' });
    const result = plan({ mappings: { prod_one: incomeId }, allRows: [row], visibleRows: [row],
      payouts: [{ id: 'po_one', status: 'paid', automatic: true, amount: 35525, currency: 'aed', arrival_date: 1780100000 }],
      contents: { po_one: [{ source: 'ch_one', type: 'charge', amount: 36725, fee: 1200, net: 35525, currency: 'aed' }] } });
    assert.equal(result.issues.length, 0);
    const invoice = result.entries.find((e) => e.type === 'payment');
    assert.equal(amount(invoice, 31758052), 36725);   // Dr Stripe receivables
    assert.equal(amount(invoice, incomeId), -36725);  // Cr plan income
    const payout = result.entries.find((e) => e.type === 'payout');
    assert.equal(amount(payout, 31758060), 35525);    // Dr Wio Bank
    assert.equal(amount(payout, 31758096), 1200);     // Dr Stripe share
    assert.equal(amount(payout, 31758052), -36725);   // Cr Stripe receivables
    assert.equal(balance(payout), 0);
  }
});

test('mixed payout posts only Sentink bank and fees, excluding Plus', () => {
  const row = payment(), excluded = payment({ id: 'cs_two:li_two', source_id: 'ch_plus', product: 'Sentink Plus', product_id: 'prod_plus', settle_gross: 10000 });
  const result = plan({ allRows: [row, excluded], visibleRows: [row],
    payouts: [{ id: 'po_one', status: 'paid', automatic: true, amount: 45225, currency: 'aed', arrival_date: 1780100000 }],
    contents: { po_one: [
      { source: 'ch_one', type: 'charge', amount: 36725, fee: 1200, net: 35525, currency: 'aed' },
      { source: 'ch_plus', type: 'charge', amount: 10000, fee: 300, net: 9700, currency: 'aed' },
    ] } });
  const entry = result.entries.find((e) => e.type === 'payout');
  assert.ok(entry);
  assert.equal(amount(entry, 31758060), 35525);
  assert.equal(amount(entry, 31758096), 1200);
  assert.equal(amount(entry, 31758052), -36725);
  assert.equal(balance(entry), 0);
  assert.deepEqual(entry.dependencies, [result.entries[0].key]);
});

test('Sentink payout includes separate Billing fees and their VAT at exact net cost', () => {
  const row = payment({ settle_gross: 157393 });
  const result = plan({ allRows: [row], visibleRows: [row],
    payouts: [{ id: 'po_billing', status: 'paid', automatic: true, currency: 'aed', amount: 147804, arrival_date: 1780100000 }],
    contents: { po_billing: [
      { type: 'charge', source: 'ch_one', amount: 157393, fee: 8514, net: 148879, currency: 'aed' },
      { type: 'stripe_fee', amount: -769, fee: 38, net: -807, currency: 'aed' },
      { type: 'stripe_fee', amount: -255, fee: 13, net: -268, currency: 'aed' },
    ] } });
  assert.equal(result.issues.length, 0);
  const payout = result.entries.find((entry) => entry.type === 'payout');
  assert.equal(amount(payout, 31758060), 147804);
  assert.equal(amount(payout, 31758096), 9589);
  assert.equal(amount(payout, 31758052), -157393);
  assert.equal(balance(payout), 0);
  const existing = { entry_key: result.entries[0].key, payload_hash: digest(result.entries[0]), intact: true };
  assert.deepEqual(annotate(result, [existing]).entries.map((entry) => entry.status), ['synced', 'ready']);
});

test('known Stripe service, FX and fee-tax transactions reduce bank and increase Stripe share', () => {
  for (const type of ['stripe_fee', 'stripe_fx_fee', 'tax_fee']) {
    const result = plan({
      payouts: [{ id: 'po_fee', status: 'paid', automatic: true, currency: 'aed', amount: 35420, arrival_date: 1780100000 }],
      contents: { po_fee: [
        { type: 'charge', source: 'ch_one', amount: 36725, fee: 1200, net: 35525, currency: 'aed' },
        { type, amount: -100, fee: 5, net: -105, currency: 'aed' },
      ] } });
    const payout = result.entries.find((entry) => entry.type === 'payout');
    assert.equal(amount(payout, 31758060), 35420);
    assert.equal(amount(payout, 31758096), 1305);
    assert.equal(balance(payout), 0);
  }
});

test('shared service fees in a mixed Sentink/Plus payout require allocation', () => {
  const row = payment(), excluded = payment({ id: 'li_plus', source_id: 'ch_plus' });
  const result = plan({ allRows: [row, excluded], visibleRows: [row],
    payouts: [{ id: 'po_mixed', status: 'paid', automatic: true, currency: 'aed', amount: 71050 - 105, arrival_date: 1780100000 }],
    contents: { po_mixed: [
      { type: 'charge', source: 'ch_one', amount: 36725, fee: 1200, net: 35525, currency: 'aed' },
      { type: 'charge', source: 'ch_plus', amount: 36725, fee: 1200, net: 35525, currency: 'aed' },
      { type: 'stripe_fee', amount: -100, fee: 5, net: -105, currency: 'aed' },
    ] } });
  assert.equal(result.entries.filter((entry) => entry.type === 'payout').length, 0);
  assert.match(result.issues[0].message, /shared Stripe service fees/);
});

test('Stripe service fee credits decrease the fee expense without changing receivables', () => {
  const result = plan({
    payouts: [{ id: 'po_credit', status: 'paid', automatic: true, currency: 'aed', amount: 35625, arrival_date: 1780100000 }],
    contents: { po_credit: [
      { type: 'charge', source: 'ch_one', amount: 36725, fee: 1200, net: 35525, currency: 'aed' },
      { type: 'stripe_fee', amount: 100, fee: 0, net: 100, currency: 'aed' },
    ] } });
  const payout = result.entries.find((entry) => entry.type === 'payout');
  assert.equal(amount(payout, 31758060), 35625);
  assert.equal(amount(payout, 31758096), 1100);
  assert.equal(amount(payout, 31758052), -36725);
});

test('inconsistent service-fee amounts cannot create a payout journal', () => {
  const result = plan({
    payouts: [{ id: 'po_badfee', status: 'paid', automatic: true, currency: 'aed', amount: 35025, arrival_date: 1780100000 }],
    contents: { po_badfee: [
      { type: 'charge', source: 'ch_one', amount: 36725, fee: 1200, net: 35525, currency: 'aed' },
      { type: 'stripe_fee', amount: -100, fee: 5, net: -500, currency: 'aed' },
    ] } });
  assert.equal(result.entries.filter((entry) => entry.type === 'payout').length, 0);
  assert.match(result.issues[0].message, /totals differ/);
});

test('refund reverses original income allocations and payout clears net receivables', () => {
  const row = payment({ amount: 10001, currency: 'aed', settle_gross: 10001 });
  const other = payment({ id: 'cs_one:li_two', product_id: 'prod_two', amount: 20000, currency: 'aed', settle_gross: 20000 });
  const refund = { id: 're_one', source_id: 're_one', kind: 'refund', status: 'refund', amount: -10000, currency: 'aed', payment_intent: 'pi_one', settle_gross: -10000, settle_currency: 'aed', created: 1780010000 };
  const result = plan({ allRows: [row, other, refund], visibleRows: [row, other, refund], mappings: { prod_one: 31758077, prod_two: 31758082 },
    payouts: [{ id: 'po_one', status: 'paid', automatic: true, amount: 19001, currency: 'aed', arrival_date: 1780100000 }],
    contents: { po_one: [
      { source: 'ch_one', type: 'charge', amount: 30001, fee: 1000, net: 29001, currency: 'aed' },
      { source: 're_one', type: 'refund', amount: -10000, fee: 0, net: -10000, currency: 'aed' },
    ] } });
  assert.equal(result.issues.length, 0);
  const reversal = result.entries.find((e) => e.type === 'refund');
  assert.equal(amount(reversal, 31758052), -10000);
  assert.equal(amount(reversal, 31758077) + amount(reversal, 31758082), 10000);
  assert.equal(result.entries.reduce((sum, e) => sum + amount(e, 31758052), 0), 0);
  result.entries.forEach((entry) => assert.equal(balance(entry), 0));
  assert.match(reversal.reason, /jane@example\.com/);
  assert.equal(reversal.approval, 'pending');
});

test('a full refund exactly reverses the original income and separates any exchange difference', () => {
  const row = payment();
  const refund = { id: 're_full', source_id: 're_full', original_charge: 'ch_one', kind: 'refund', status: 'refund', amount: -10000, currency: 'usd', settle_gross: -36800, settle_currency: 'aed', created: row.created + 10 };
  const result = plan({ allRows: [row, refund], visibleRows: [row, refund] });
  assert.equal(result.issues.length, 0);
  const reversal = result.entries.find(entry => entry.type === 'refund');
  assert.equal(amount(reversal, 31758077), 36725);
  assert.equal(amount(reversal, 31758052), -36800);
  assert.equal(amount(reversal, 31758096), 75);
  assert.equal(result.entries.reduce((sum, entry) => sum + amount(entry, 31758077), 0), 0);
  assert.equal(balance(reversal), 0);
});

test('multiple partial refunds fully unwind every original income ledger without a rounding remainder', () => {
  const first = payment({ amount: 1, currency: 'aed', settle_gross: 1 });
  const second = payment({ id: 'li_two', product_id: 'prod_two', amount: 2, currency: 'aed', settle_gross: 2 });
  const refunds = [1, 2, 3].map(i => ({ id: `re_${i}`, source_id: `re_${i}`, original_charge: 'ch_one', kind: 'refund', status: 'refund', amount: -1, currency: 'aed', settle_gross: -1, settle_currency: 'aed', created: first.created + i }));
  const rows = [first, second, ...refunds.reverse()];
  const result = plan({ allRows: rows, visibleRows: rows, mappings: { prod_one: 31758077, prod_two: 31758082 } });
  assert.equal(result.issues.length, 0);
  assert.equal(result.entries.filter(entry => entry.type === 'refund').length, 3);
  assert.equal(result.entries.reduce((sum, entry) => sum + amount(entry, 31758077), 0), 0);
  assert.equal(result.entries.reduce((sum, entry) => sum + amount(entry, 31758082), 0), 0);
  result.entries.forEach(entry => assert.equal(balance(entry), 0));
  const reversals = result.entries.filter(entry => entry.type === 'refund');
  assert.ok(reversals[1].dependencies.includes(reversals[0].key));
  assert.ok(reversals[2].dependencies.includes(reversals[1].key));
});

test('unsuccessful refunds are not recognised as completed reversals', () => {
  const row = payment();
  const refund = { ...row, id: 're_pending', source_id: 're_pending', kind: 'refund', status: 'refund pending', amount: -10000, settle_gross: -36725 };
  assert.equal(plan({ allRows: [row, refund], visibleRows: [row, refund] }).entries.filter(entry => entry.type === 'refund').length, 0);
});

test('missing mappings block the whole charge and its payout', () => {
  const result = plan({ mappings: {}, payouts: [{ id: 'po_one', status: 'paid', automatic: true, amount: 35525, currency: 'aed' }], contents: { po_one: [{ source: 'ch_one', type: 'charge', amount: 36725, fee: 1200, net: 35525, currency: 'aed' }] } });
  assert.equal(result.entries.length, 0);
  assert.equal(result.issues.length, 2);
});

test('a charge containing both visible and excluded lines is blocked', () => {
  const row = payment(), hidden = payment({ id: 'li_hidden', product: 'Sentink Plus' });
  const result = plan({ allRows: [row, hidden], visibleRows: [row] });
  assert.equal(result.entries.length, 0);
  assert.match(result.issues[0].message, /mixes/);
});

test('wrong currencies, unsettled charges and unsuccessful payments do not post', () => {
  assert.equal(plan({ allRows: [payment({ settle_currency: 'usd' })] }).entries.length, 0);
  assert.equal(plan({ allRows: [payment({ settle_gross: undefined })] }).entries.length, 0);
  const failed = payment({ kind: 'failed', status: 'failed' });
  const result = plan({ allRows: [failed], visibleRows: [failed] });
  assert.equal(result.entries.length, 0);
  assert.equal(result.skipped.length, 1);
});

test('only paid automatic payouts with complete reconciled contents can post', () => {
  for (const status of ['pending', 'in_transit', 'failed', 'canceled']) {
    assert.equal(plan({ payouts: [{ id: 'po_x', status }] }).entries.filter((e) => e.type === 'payout').length, 0);
  }
  assert.match(plan({ payouts: [{ id: 'po_x', status: 'paid', automatic: false }] }).issues[0].message, /Manual/);
  const base = { id: 'po_x', status: 'paid', automatic: true, currency: 'aed', amount: 1 };
  assert.match(plan({ payouts: [base], contents: { po_x: [{ type: 'charge', source: 'ch_one', currency: 'aed', net: 35525 }] } }).issues[0].message, /reconcile/);
  assert.match(plan({ payouts: [{ ...base, amount: 35525 }], contents: { po_x: [{ type: 'adjustment', source: 'dp_one', currency: 'aed', net: 35525 }] } }).issues[0].message, /manual review/);
});

test('stored receipt hashes skip identical entries and flag changed/deleted journals', () => {
  const base = plan();
  const receipt = { entry_key: base.entries[0].key, payload_hash: digest(base.entries[0]), intact: true };
  assert.equal(annotate(base, [receipt]).entries[0].status, 'synced');
  assert.equal(annotate(base, [{ ...receipt, intact: false }]).entries[0].status, 'conflict');
  assert.equal(annotate(base, [{ ...receipt, payload_hash: 'changed' }]).entries[0].status, 'conflict');
  assert.equal(annotate(base, []).entries[0].status, 'ready');
});

test('dependency conflicts prevent dependent payout posting', () => {
  const base = plan();
  base.entries.push({ ...base.entries[0], key: 'payout', type: 'payout', dependencies: [base.entries[0].key] });
  const result = annotate(base, [{ entry_key: base.entries[0].key, payload_hash: digest(base.entries[0]), intact: false }]);
  assert.equal(result.entries[1].status, 'conflict');
});

test('fully deleted unchanged journals can be restored before dependent payouts', () => {
  const base = plan();
  base.entries.push({ ...base.entries[0], key: 'payout', type: 'payout', dependencies: [base.entries[0].key] });
  const receipt = { entry_key: base.entries[0].key, payload_hash: digest(base.entries[0]), intact: false, restorable: true };
  assert.deepEqual(annotate(base, [receipt]).entries.map((entry) => entry.status), ['restore', 'ready']);
  assert.deepEqual(annotate(base, [{ ...receipt, payload_hash: 'changed' }]).entries.map((entry) => entry.status), ['conflict', 'conflict']);
});

test('memo and pending-policy upgrades preserve financial identity and support deleted records', () => {
  const base = plan();
  const legacy = { ...base.entries[0], reason: 'Old memo' };
  delete legacy.version; delete legacy.approval;
  const receipt = { entry_key: legacy.key, payload_hash: digest(legacy), financial_hash: financialDigest(legacy), intact: true };
  const active = annotate(base, [receipt]).entries[0];
  assert.equal(active.status, 'update'); assert.equal(active.upgrade_metadata, true); assert.equal(active.restore_deleted, false);
  const deleted = annotate(base, [{ ...receipt, intact: false, restorable: true }]).entries[0];
  assert.equal(deleted.status, 'update'); assert.equal(deleted.restore_deleted, true);
  const edited = annotate(base, [{ ...receipt, intact: false, restorable: false }]).entries[0];
  assert.equal(edited.status, 'conflict');
});

test('product suggestions preserve saved decisions and omit failed payments', () => {
  const products = productsFor([payment(), payment({ id: 'other', kind: 'failed' }), payment({ id: 'third', product_id: null, product: 'Balance Top-Up' })], { prod_one: 31758082 });
  assert.equal(products.length, 2);
  assert.equal(products.find((p) => p.key === 'prod_one').ledger_id, 31758082);
  assert.equal(products.find((p) => p.key === 'name:Balance Top-Up').suggested_ledger_id, 31758082);
});

test('bridge client requires HTTPS remotely and sends server-side bearer token', async () => {
  assert.throws(() => createClient({ url: 'http://example.com/bridge', token: 'secret' }), /HTTPS/);
  assert.throws(() => createClient({ url: 'https://user:secret@example.com/bridge', token: 'secret' }), /HTTPS/);
  assert.throws(() => createClient({ url: 'https://example.com/bridge?secret=x', token: 'secret' }), /HTTPS/);
  let observed;
  const client = createClient({ url: 'http://127.0.0.1/bridge', token: 'private', fetchImpl: async (url, options) => { observed = options; return { ok: true, json: async () => ({ ok: true }) }; } });
  await client.request('POST', { payload: 'entry' });
  assert.equal(observed.headers.Authorization, 'Bearer private');
  assert.equal(observed.headers['X-Money-Master-Sync-Token'], 'private');
  assert.equal(observed.redirect, 'error');
  await assert.rejects(createClient({}).request('GET'), /Set MONEY_MASTER/);
});
