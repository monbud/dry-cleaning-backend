import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { priceItems, validTransition, validWebhook } from '../src/domain.js';
import { requestedPrices } from '../scripts/requested-prices.js';
test('totals use stored integer-kobo prices, never client-supplied amounts', () => {
  const result = priceItems([{ priceId: 'a', quantity: 3, unitAmount: 1, condition: 'Intact' }], [{ _id: 'a', category: 'Shirt', service: 'Iron only', amount: 125050, active: true }]);
  assert.equal(result.total, 375150); assert.equal(result.items[0].unitAmount, 125050);
  assert.throws(() => priceItems([{ priceId: 'other', quantity: 1 }], []));
});
test('workflow respects the services ordered and prevents skipped stages', () => {
  assert.equal(validTransition('Dropped off', 'Ironing', [{ service: 'Iron only' }]), true);
  assert.equal(validTransition('Washing', 'Ready for pickup', [{ service: 'Wash only' }]), true);
  assert.equal(validTransition('Dropped off', 'Ready for pickup', [{ service: 'Wash & iron' }]), false);
  assert.equal(validTransition('Collected', 'Washing', [{ service: 'Wash & iron' }]), false);
});
test('webhook validation rejects malformed and forged signatures', () => {
  const raw = Buffer.from('{"event":"charge.success"}');
  const signature = crypto.createHmac('sha512', 'secret').update(raw).digest('hex');
  assert.equal(validWebhook(raw, signature, 'secret'), true);
  assert.equal(validWebhook(Buffer.from('{}'), signature, 'secret'), false);
  assert.equal(validWebhook(raw, 'bad', 'secret'), false);
  assert.equal(validWebhook(raw, signature, ''), false);
});
test('requested import contains the supplied 23 clothing types and service variants', () => {
  const prices = requestedPrices('sum');
  assert.equal(prices.length, 23);
  assert.deepEqual(prices.find(p => p.category === 'JEANS'), { category: 'JEANS', wash: 40000, iron: 30000, washIron: 70000 });
  assert.equal(prices.find(p => p.category === 'DUVET').washIron, 500000);
  assert.equal(prices.find(p => p.category === 'SHOES').iron, null);
  assert.equal(prices.find(p => p.category === 'Large Size Bags or Boxes').wash, 300000);
  assert.equal(requestedPrices('unset').find(p => p.category === 'JEANS').washIron, null);
});
