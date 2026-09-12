import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import sharp from 'sharp';
import app from '../src/app.js';
import { Business, Payment, User, Session, Price, Order } from '../src/models.js';

process.env.APP_URL = 'http://localhost:3000';
const origin = 'http://localhost:3000';
let mongo, owner, outsider, business, customer, price, order, trackingToken, photoId;
const post = (agent, path, body) => agent.post(path).set('Origin', origin).send(body);
before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri()); await Promise.all(Object.values(mongoose.models).map(model => model.init()));
  owner = request.agent(app); outsider = request.agent(app);
  await post(owner, '/api/auth/register', { name: 'Owner One', email: 'owner@example.com', password: 'SecurePassword123!' }).expect(201);
  await post(outsider, '/api/auth/register', { name: 'Owner Two', email: 'other@example.com', password: 'SecurePassword123!' }).expect(201);
}, { timeout: 120000 });
after(async () => { await mongoose.disconnect(); await mongo?.stop(); });
test('authentication, CSRF protection, and business onboarding', async () => {
  await request(app).get('/api/businesses').expect(401);
  await owner.post('/api/businesses').send({}).expect(403);
  const result = await post(owner, '/api/businesses', { name: 'Test Cleaners', city: 'Lekki', state: 'Lagos', address: '10 Test Road', phone: '08012345678', listed: true }).expect(201);
  business = result.body.business;
  assert.equal(business.phone, '+2348012345678');
  assert.ok(new Date(business.subscriptionUntil) > new Date());
  const prices = await owner.get(`/api/businesses/${business._id}/prices`).expect(200); price = prices.body.prices[0];
  assert.equal(prices.body.prices.length, 5);
  const directory = await request(app).get('/api/directory').expect(200);
  assert.equal(directory.body.businesses[0].owner, undefined);
  assert.equal(directory.body.businesses[0].accountNumber, undefined);
});
test('tenant isolation protects reads, writes, and combined overview', async () => {
  await outsider.get(`/api/businesses/${business._id}/customers`).expect(404);
  await post(outsider, `/api/businesses/${business._id}/customers`, { name: 'Attack', phone: '08011111111' }).expect(404);
  const overview = await outsider.get('/api/overview').expect(200);
  assert.equal(overview.body.businesses.length, 0); assert.equal(overview.body.orders.length, 0);
});
test('returning customers are unique per business and photos stay private', async () => {
  customer = (await post(owner, `/api/businesses/${business._id}/customers`, { name: 'Ada Customer', phone: '08022222222', email: 'ada@example.com' }).expect(201)).body.customer;
  await post(owner, `/api/businesses/${business._id}/customers`, { name: 'Ada Again', phone: '+2348022222222' }).expect(409);
  const buffer = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#400039' } }).png().toBuffer();
  photoId = (await owner.post(`/api/businesses/${business._id}/photos`).set('Origin', origin).attach('photo', buffer, 'shirt.png').expect(201)).body.id;
  await request(app).get(`/api/businesses/${business._id}/photos/${photoId}`).expect(401);
  await outsider.get(`/api/businesses/${business._id}/photos/${photoId}`).expect(404);
  const image = await owner.get(`/api/businesses/${business._id}/photos/${photoId}`).expect(200);
  assert.match(image.headers['content-type'], /image\/jpeg/); assert.match(image.headers['cache-control'], /private/);
  await owner.post(`/api/businesses/${business._id}/photos`).set('Origin', origin).attach('photo', Buffer.from('<script>alert(1)</script>'), 'fake.jpg').expect(400);
});
test('orders use authoritative prices and public tracking omits private data', async () => {
  const result = await post(owner, `/api/businesses/${business._id}/orders`, { customer: customer._id, dueDate: '2026-12-20', total: 1, conditionAcknowledged: true, items: [{ priceId: price._id, quantity: 2, condition: 'Small mark on cuff', photos: [photoId], unitAmount: 1 }] }).expect(201);
  order = result.body.order; trackingToken = result.body.trackingUrl.split('/').at(-1);
  assert.equal(order.total, price.amount * 2);
  await owner.patch(`/api/businesses/${business._id}/prices/${price._id}`).set('Origin', origin).send({ category: price.category, service: price.service, amount: 99900 }).expect(200);
  const saved = await owner.get(`/api/businesses/${business._id}/orders/${order._id}`).expect(200);
  assert.equal(saved.body.order.total, price.amount * 2);
  const tracked = await request(app).get(`/api/track/${trackingToken}`).expect(200);
  assert.equal(tracked.body.order.customer, undefined); assert.equal(tracked.body.order.items[0].photos, undefined); assert.equal(tracked.body.order.history[0].actor, undefined); assert.equal(tracked.body.order.items[0].condition, undefined);
  await request(app).get(`/api/track/${order.reference}`).expect(404);
});
test('foreign customer and price IDs cannot be inserted into orders', async () => {
  const foreign = (await post(outsider, '/api/businesses', { name: 'Other Cleaners', city: 'Ikeja', state: 'Lagos', address: '20 Test Road', phone: '08033333333' }).expect(201)).body.business;
  const wrongCustomer = await post(owner, `/api/businesses/${business._id}/orders`, { customer: foreign._id, dueDate: '2026-12-20', conditionAcknowledged: false, items: [{ priceId: price._id, quantity: 1, condition: 'Intact' }] }); assert.equal(wrongCustomer.status, 404);
  await post(outsider, `/api/businesses/${foreign._id}/orders`, { customer: customer._id, dueDate: '2026-12-20', conditionAcknowledged: true, items: [{ priceId: price._id, quantity: 1, condition: 'Intact' }] }).expect(404);
});
test('status transitions are sequential, payment records resist duplicates, and expiry preserves reads', async () => {
  await owner.patch(`/api/businesses/${business._id}/orders/${order._id}/status`).set('Origin', origin).send({ status: 'Collected' }).expect(409);
  await owner.patch(`/api/businesses/${business._id}/orders/${order._id}/status`).set('Origin', origin).send({ status: 'Washing' }).expect(200);
  const responses = await Promise.all([post(owner, `/api/businesses/${business._id}/orders/${order._id}/payment`, { channel: 'Cash' }), post(owner, `/api/businesses/${business._id}/orders/${order._id}/payment`, { channel: 'Cash' })]);
  assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
  assert.equal(await Payment.countDocuments({ order: order._id }), 1);
  await Business.updateOne({ _id: business._id }, { subscriptionUntil: new Date(0) });
  await post(owner, `/api/businesses/${business._id}/customers`, { name: 'New Customer', phone: '08044444444' }).expect(402);
  await owner.get(`/api/businesses/${business._id}/orders`).expect(200);
  await owner.delete(`/api/businesses/${business._id}`).set('Origin', origin).expect(409);
});
test('free access permits expired business writes, prevents renewal charges, and can be reversed', async () => {
  const previous = process.env.SUBSCRIPTIONS_REQUIRED;
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => { providerCalls++; throw new Error('Unexpected provider call'); };
  const base = `/api/businesses/${business._id}`;
  try {
    process.env.SUBSCRIPTIONS_REQUIRED = 'false';
    assert.equal((await owner.get('/api/overview').expect(200)).body.subscriptionsRequired, false);
    await post(owner, `${base}/customers`, { name: 'Free Customer', phone: '08044444444' }).expect(201);
    await post(owner, `${base}/prices`, { category: 'Free service', service: 'Wash only', amount: 10000 }).expect(201);
    const buffer = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#400039' } }).png().toBuffer();
    await owner.post(`${base}/photos`).set('Origin', origin).attach('photo', buffer, 'free.png').expect(201);
    await post(owner, `${base}/orders`, { customer: customer._id, dueDate: '2026-12-20', conditionAcknowledged: true, items: [{ priceId: price._id, quantity: 1, condition: 'Intact' }] }).expect(201);
    await post(owner, `${base}/expenses`, { supplier: 'Test supplier', description: 'Supplies', amount: 10000, date: '2026-09-12', method: 'Cash' }).expect(201);
    const paymentsBefore = await Payment.countDocuments();
    await post(owner, `${base}/subscription`, {}).expect(409);
    assert.equal(providerCalls, 0);
    assert.equal(await Payment.countDocuments(), paymentsBefore);
    await post(outsider, `${base}/customers`, { name: 'Attack', phone: '08055555555' }).expect(404);
    assert.equal((await Business.findById(business._id)).subscriptionUntil.getTime(), 0);
    for (const value of ['true', undefined]) {
      if (value === undefined) delete process.env.SUBSCRIPTIONS_REQUIRED;
      else process.env.SUBSCRIPTIONS_REQUIRED = value;
      assert.equal((await owner.get('/api/overview').expect(200)).body.subscriptionsRequired, true);
      await post(owner, `${base}/customers`, { name: 'Blocked', phone: '08055555555' }).expect(402);
      await owner.get(`${base}/orders`).expect(200);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.SUBSCRIPTIONS_REQUIRED;
    else process.env.SUBSCRIPTIONS_REQUIRED = previous;
  }
});

test('webhook settlement verifies provider amount and extends subscription only once', async () => {
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_example';
  const originalFetch = globalThis.fetch; let amount = 99900;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ status: true, data: { status: 'success', currency: 'NGN', amount, reference: 'SUB-TEST' } }) });
  try {
    await Payment.create({ business: business._id, kind: 'subscription', amount: 100000, reference: 'SUB-TEST', channel: 'Paystack' });
    const event = JSON.stringify({ event: 'charge.success', data: { reference: 'SUB-TEST' } });
    const signature = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(event).digest('hex');
    await request(app).post('/api/payments/webhook').set('Content-Type', 'application/json').set('x-paystack-signature', 'bad').send(event).expect(401);
    await request(app).post('/api/payments/webhook').set('Content-Type', 'application/json').set('x-paystack-signature', signature).send(event).expect(409);
    assert.equal((await Payment.findOne({ reference: 'SUB-TEST' })).status, 'pending');
    amount = 100000;
    await request(app).post('/api/payments/webhook').set('Content-Type', 'application/json').set('x-paystack-signature', signature).send(event).expect(200);
    const until = (await Business.findById(business._id)).subscriptionUntil.getTime();
    await request(app).post('/api/payments/webhook').set('Content-Type', 'application/json').set('x-paystack-signature', signature).send(event).expect(200);
    assert.equal((await Business.findById(business._id)).subscriptionUntil.getTime(), until);
    assert.ok(until > Date.now());
  } finally { globalThis.fetch = originalFetch; delete process.env.PAYSTACK_SECRET_KEY; }
});
test('password changes revoke old sessions and logout revokes current session', async () => {
  const oldSession = request.agent(app);
  await post(oldSession, '/api/auth/login', { email: 'owner@example.com', password: 'SecurePassword123!' }).expect(200);
  await post(owner, '/api/auth/password', { currentPassword: 'SecurePassword123!', password: 'UpdatedPassword123!' }).expect(200);
  await oldSession.get('/api/auth/profile').expect(401);
  await owner.get('/api/auth/profile').expect(200);
  await post(owner, '/api/auth/logout', {}).expect(200);
  await owner.get('/api/auth/profile').expect(401);
});
test('account deletion requires a password and removes credentials and sessions', async () => {
  const agent = request.agent(app);
  await post(agent, '/api/auth/register', { name: 'Delete Me', email: 'delete@example.com', password: 'SecurePassword123!' }).expect(201);
  const user = await User.findOne({ email: 'delete@example.com' });
  await agent.delete('/api/auth/account').set('Origin', origin).send({ password: 'wrong' }).expect(400);
  await agent.delete('/api/auth/account').set('Origin', origin).send({ password: 'SecurePassword123!' }).expect(200);
  assert.equal(await User.findById(user._id), null); assert.equal(await Session.countDocuments({ user: user._id }), 0);
});
test('Mailjet reset links are hashed, single-use, expire, and revoke sessions', async () => {
  const agent = request.agent(app);
  await post(agent, '/api/auth/register', { name: 'Reset Test', email: 'reset@example.com', password: 'SecurePassword123!' }).expect(201);
  process.env.MAILJET_API_KEY = 'test'; process.env.MAILJET_SECRET_KEY = 'test'; process.env.MAIL_FROM = 'sender@example.com';
  const originalFetch = globalThis.fetch; let mail;
  globalThis.fetch = async (url, options) => { assert.equal(url, 'https://api.mailjet.com/v3.1/send'); mail = JSON.parse(options.body); return { ok: true }; };
  try {
    const result = await post(agent, '/api/auth/forgot-password', { email: 'reset@example.com' }).expect(200);
    assert.equal(result.body.token, undefined);
    const resetToken = mail.Messages[0].TextPart.match(/token=([a-f0-9]{64})/)[1];
    const user = await User.findOne({ email: 'reset@example.com' }).select('+resetHash');
    assert.notEqual(user.resetHash, resetToken); assert.ok(user.resetExpires > new Date());
    const anonymous = request.agent(app);
    await post(anonymous, '/api/auth/reset-password', { token: resetToken, password: 'BrandNewPassword123!' }).expect(200);
    await agent.get('/api/auth/profile').expect(401);
    await post(anonymous, '/api/auth/reset-password', { token: resetToken, password: 'AnotherPassword123!' }).expect(400);
    await post(anonymous, '/api/auth/login', { email: 'reset@example.com', password: 'BrandNewPassword123!' }).expect(200);
    await User.updateOne({ _id: user._id }, { resetHash: crypto.createHash('sha256').update(resetToken).digest('hex'), resetExpires: new Date(0) });
    await post(anonymous, '/api/auth/reset-password', { token: resetToken, password: 'AnotherPassword123!' }).expect(400);
  } finally { globalThis.fetch = originalFetch; delete process.env.MAILJET_API_KEY; delete process.env.MAILJET_SECRET_KEY; delete process.env.MAIL_FROM; }
});
test('clothing types save three independent prices atomically and preserve order snapshots', async () => {
  const agent = request.agent(app);
  await post(agent, '/api/auth/login', { email: 'owner@example.com', password: 'UpdatedPassword123!' }).expect(200);
  const path = `/api/businesses/${business._id}/price-groups`;
  const values = { category: 'GROUP TEST', wash: 50000, iron: 30000, washIron: 75000 };
  const created = (await post(agent, path, values).expect(201)).body.group;
  assert.equal(created.washIron, 75000); // Combined need not equal the sum.
  await post(agent, path, { ...values, category: ' group   test ' }).expect(409);
  await post(agent, path, { category: 'Empty', wash: null, iron: null, washIron: null }).expect(400);
  await post(agent, path, { ...values, category: 'Invalid', wash: -1 }).expect(400);
  await outsider.patch(`${path}/${created._id}`).set('Origin', origin).send(values).expect(404);
  const wash = await Price.findOne({ business: business._id, category: values.category, service: 'Wash only', active: true });
  const received = (await post(agent, `/api/businesses/${business._id}/orders`, { customer: customer._id, dueDate: '2026-12-20', conditionAcknowledged: true, items: [{ priceId: String(wash._id), quantity: 2, condition: 'Intact' }] }).expect(201)).body.order;
  await agent.patch(`${path}/${created._id}`).set('Origin', origin).send({ category: 'Renamed clothing', wash: 60000, iron: null, washIron: 80000 }).expect(200);
  assert.equal((await Order.findById(received._id)).total, 100000);
  assert.equal((await Order.findById(received._id)).items[0].category, 'GROUP TEST');
  assert.equal(await Price.countDocuments({ business: business._id, category: 'Renamed clothing', active: true }), 2);
  const updated = (await agent.get(`/api/businesses/${business._id}/prices`)).body.groups.find(g => g.category === 'Renamed clothing');
  await agent.delete(`${path}/${updated._id}`).set('Origin', origin).expect(200);
  assert.equal(await Price.countDocuments({ business: business._id, category: 'Renamed clothing', active: true }), 0);
  const concurrent = await Promise.all([post(agent, path, { ...values, category: 'Concurrent' }), post(agent, path, { ...values, category: 'CONCURRENT' })]);
  assert.deepEqual(concurrent.map(r => r.status).sort(), [201, 409]);
});
test('public business profiles expose active pricing and notices, keeping private businesses and records hidden', async () => {
  await Business.updateOne({ _id: business._id }, { notice: 'Open Monday to Saturday', bankName: 'Private bank', accountNumber: '1234567890' });
  const result = (await request(app).get(`/api/directory/${business._id}`).expect(200)).body;
  assert.equal(result.business.notice, 'Open Monday to Saturday');
  assert.equal(result.business.owner, undefined); assert.equal(result.business.accountNumber, undefined); assert.equal(result.business.bankName, undefined);
  assert.ok(result.services.some(s => s.category.toUpperCase() === 'CONCURRENT' && s.washIron === 75000));
  assert.equal(result.services.some(s => s.category === 'Renamed clothing'), false);
  assert.equal(result.services[0].business, undefined);
  await request(app).get('/api/directory/invalid').expect(404);
  await Business.updateOne({ _id: business._id }, { listed: false });
  await request(app).get(`/api/directory/${business._id}`).expect(404);
  await Business.updateOne({ _id: business._id }, { listed: true, archived: true });
  await request(app).get(`/api/directory/${business._id}`).expect(404);
});
