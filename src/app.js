import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import multer from 'multer';
import sharp from 'sharp';
import { z } from 'zod';
import { User, Session, Business, Customer, Price, Order, Photo, Payment, Expense, STATUSES } from './models.js';
import { token, hash, reference, priceItems, validTransition, validWebhook } from './domain.js';
import { sendReset, paystack } from './services.js';
import { groupPrices, savePriceGroup, removePriceGroup } from './pricing.js';

const app = express();
app.disable('x-powered-by');
app.use(helmet());
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid identifier');
const short = z.string().trim().min(1).max(160);
const optionalText = z.string().trim().max(2000).default('');
const email = z.email().max(254).transform(s => s.toLowerCase());
const phone = z.string().trim().regex(/^(?:\+234|0)[789]\d{9}$/, 'Enter a Nigerian mobile number').transform(s => s.startsWith('0') ? `+234${s.slice(1)}` : s);
const money = z.number().int().min(100).max(100000000); // Integer kobo throughout.
const password = z.string().min(10).max(72).refine(value => Buffer.byteLength(value, 'utf8') <= 72, 'Password must fit within 72 UTF-8 bytes');
const appUrl = () => process.env.APP_URL || 'http://localhost:3000';
const cookieOptions = () => ({ httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' });
async function session(res, user) {
  const raw = token();
  await Session.create({ user: user._id, hash: hash(raw), expires: new Date(Date.now() + 7 * 86400000) });
  res.cookie('finbud_session', raw, { ...cookieOptions(), maxAge: 7 * 86400000 });
}
async function auth(req, res, next) {
  res.set('Cache-Control', 'no-store');
  const raw = req.cookies.finbud_session;
  if (!raw) return res.status(401).json({ error: 'Please sign in.' });
  const found = await Session.findOne({ hash: hash(raw), expires: { $gt: new Date() } }).populate('user');
  if (!found?.user) return res.status(401).json({ error: 'Your session has expired. Please sign in.' });
  req.user = found.user; next();
}
async function tenant(req, res, next) {
  const id = objectId.parse(req.params.businessId);
  req.business = await Business.findOne({ _id: id, owner: req.user._id, archived: false });
  if (!req.business) return res.status(404).json({ error: 'Business not found.' });
  next();
}
const activeSubscription = (req, res, next) => {
  if (!req.business.subscriptionUntil || req.business.subscriptionUntil < new Date()) return res.status(402).json({ error: 'Renew this business subscription to add new records. Existing records remain accessible.' });
  next();
};

// Raw body must be preserved for Paystack signature verification.
app.post('/api/payments/webhook', express.raw({ type: 'application/json', limit: '256kb' }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !validWebhook(req.body, req.get('x-paystack-signature'), process.env.PAYSTACK_SECRET_KEY)) return res.sendStatus(401);
  const event = JSON.parse(req.body.toString());
  if (event.event === 'charge.success') await settlePayment(event.data.reference);
  res.sendStatus(200);
});
app.use(express.json({ limit: '512kb' }));
app.use(cookieParser());
// Browser mutations must come from the configured frontend origin.
app.use('/api', (req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('origin') !== new URL(appUrl()).origin) return res.status(403).json({ error: 'Request origin is not allowed.' });
  next();
});
app.use('/api', rateLimit({ windowMs: 60000, limit: 180, standardHeaders: 'draft-8', legacyHeaders: false }));
app.get('/api/health', (req, res) => res.status(mongoose.connection.readyState === 1 ? 200 : 503).json({ status: mongoose.connection.readyState === 1 ? 'ok' : 'database unavailable' }));
const authLimiter = rateLimit({ windowMs: 15 * 60000, limit: 25, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many attempts. Please try again in 15 minutes.' } });
app.post('/api/auth/register', authLimiter, async (req, res) => {
  const data = z.object({ name: short, email, password }).parse(req.body);
  const user = await User.create({ ...data, password: await bcrypt.hash(data.password, 12) });
  await session(res, user);
  res.status(201).json({ user: { _id: user._id, name: user.name, email: user.email } });
});
app.post('/api/auth/login', authLimiter, async (req, res) => {
  const data = z.object({ email, password: z.string().max(72) }).parse(req.body);
  const user = await User.findOne({ email: data.email }).select('+password');
  if (!user || !await bcrypt.compare(data.password, user.password)) fail(401, 'Email or password is incorrect.');
  await session(res, user);
  res.json({ user: { _id: user._id, name: user.name, email: user.email } });
});
app.post('/api/auth/logout', async (req, res) => {
  if (req.cookies.finbud_session) await Session.deleteOne({ hash: hash(req.cookies.finbud_session) });
  res.clearCookie('finbud_session', cookieOptions()).json({ ok: true });
});
app.get('/api/auth/profile', auth, (req, res) => res.json({ user: req.user }));
app.patch('/api/auth/profile', auth, async (req, res) => {
  const data = z.object({ name: short }).parse(req.body);
  res.json({ user: await User.findByIdAndUpdate(req.user._id, data, { new: true }) });
});
app.post('/api/auth/password', auth, authLimiter, async (req, res) => {
  const data = z.object({ currentPassword: z.string().max(72), password }).parse(req.body);
  const user = await User.findById(req.user._id).select('+password');
  if (!await bcrypt.compare(data.currentPassword, user.password)) fail(400, 'Current password is incorrect.');
  user.password = await bcrypt.hash(data.password, 12); user.resetHash = undefined; user.resetExpires = undefined; await user.save();
  await Session.deleteMany({ user: user._id }); await session(res, user); res.json({ ok: true });
});
app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
  const data = z.object({ email }).parse(req.body);
  if (!process.env.MAILJET_API_KEY || !process.env.MAILJET_SECRET_KEY || !process.env.MAIL_FROM) fail(503, 'Password reset email is not configured. Contact the administrator.');
  const user = await User.findOne({ email: data.email });
  if (user) {
    const raw = token(); user.resetHash = hash(raw); user.resetExpires = new Date(Date.now() + 30 * 60000); await user.save();
    await sendReset(user.email, `${appUrl()}/reset-password?token=${raw}`);
  }
  res.json({ message: 'If an account exists, a password reset email will arrive shortly.' });
});
app.post('/api/auth/reset-password', authLimiter, async (req, res) => {
  const data = z.object({ token: z.string().length(64), password }).parse(req.body);
  const updated = await User.findOneAndUpdate({ resetHash: hash(data.token), resetExpires: { $gt: new Date() } }, { $set: { password: await bcrypt.hash(data.password, 12) }, $unset: { resetHash: 1, resetExpires: 1 } });
  if (!updated) fail(400, 'This reset link is invalid or expired.');
  await Session.deleteMany({ user: updated._id }); res.json({ ok: true });
});
app.delete('/api/auth/account', auth, async (req, res) => {
  const data = z.object({ password: z.string().max(72) }).parse(req.body);
  const user = await User.findById(req.user._id).select('+password');
  if (!await bcrypt.compare(data.password, user.password)) fail(400, 'Password is incorrect.');
  if (await Business.exists({ owner: user._id, archived: false })) fail(409, 'Archive your businesses in Settings before deleting your account.');
  await Session.deleteMany({ user: user._id }); await User.deleteOne({ _id: user._id });
  res.clearCookie('finbud_session', cookieOptions()).json({ ok: true });
});

const businessInput = z.object({ name: short, city: short, state: short, address: short, phone, description: optionalText, notice: optionalText, bankName: z.string().trim().max(80).default(''), accountName: z.string().trim().max(120).default(''), accountNumber: z.union([z.literal(''), z.string().regex(/^\d{10}$/)]).default(''), listed: z.boolean().default(false) });
app.get('/api/businesses', auth, async (req, res) => res.json({ businesses: await Business.find({ owner: req.user._id, archived: false }).sort({ createdAt: 1 }) }));
app.post('/api/businesses', auth, async (req, res) => {
  const data = businessInput.parse(req.body);
  const business = await Business.create({ ...data, owner: req.user._id, subscriptionUntil: new Date(Date.now() + 14 * 86400000) });
  await Price.insertMany([['Shirt', 150000], ['Trousers', 150000], ['Dress', 250000], ['Agbada', 500000], ['Duvet', 600000]].map(([category, amount]) => ({ business: business._id, category, service: 'Wash & iron', amount })));
  res.status(201).json({ business });
});
const router = express.Router({ mergeParams: true });
app.use('/api/businesses/:businessId', auth, tenant, router);
router.patch('/', async (req, res) => res.json({ business: await Business.findByIdAndUpdate(req.business._id, businessInput.parse(req.body), { new: true }) }));
router.delete('/', async (req, res) => {
  if (await Order.exists({ business: req.business._id, status: { $ne: 'Collected' } })) fail(409, 'Complete all outstanding orders before archiving this business.');
  await Business.updateOne({ _id: req.business._id }, { archived: true, listed: false }); res.json({ ok: true });
});
router.get('/customers', async (req, res) => res.json({ customers: await Customer.find({ business: req.business._id }).sort({ name: 1 }).limit(1000) }));
const customerInput = z.object({ name: short, phone, email: z.union([email, z.literal('')]).default('') });
router.post('/customers', activeSubscription, async (req, res) => res.status(201).json({ customer: await Customer.create({ ...customerInput.parse(req.body), business: req.business._id }) }));
router.patch('/customers/:id', async (req, res) => {
  const customer = await Customer.findOneAndUpdate({ _id: objectId.parse(req.params.id), business: req.business._id }, customerInput.parse(req.body), { new: true });
  if (!customer) fail(404, 'Customer not found.'); res.json({ customer });
});
router.get('/prices', async (req, res) => {
  const prices = await Price.find({ business: req.business._id, active: true }).sort({ category: 1, _id: 1 });
  res.json({ prices, groups: groupPrices(prices) });
});
const priceGroupInput = z.object({ category: short, wash: money.nullable(), iron: money.nullable(), washIron: money.nullable() }).refine(data => [data.wash, data.iron, data.washIron].some(amount => amount !== null), 'Set at least one service price.');
router.post('/price-groups', activeSubscription, async (req, res) => res.status(201).json({ group: await savePriceGroup(req.business._id, priceGroupInput.parse(req.body)) }));
router.patch('/price-groups/:id', async (req, res) => res.json({ group: await savePriceGroup(req.business._id, priceGroupInput.parse(req.body), objectId.parse(req.params.id)) }));
router.delete('/price-groups/:id', async (req, res) => { await removePriceGroup(req.business._id, objectId.parse(req.params.id)); res.json({ ok: true }); });
const priceInput = z.object({ category: short, service: z.enum(['Wash & iron', 'Wash only', 'Iron only']), amount: money });
router.post('/prices', activeSubscription, async (req, res) => res.status(201).json({ price: await Price.create({ ...priceInput.parse(req.body), business: req.business._id }) }));
router.patch('/prices/:id', async (req, res) => {
  const price = await Price.findOneAndUpdate({ _id: objectId.parse(req.params.id), business: req.business._id, active: true }, priceInput.parse(req.body), { new: true });
  if (!price) fail(404, 'Price not found.'); res.json({ price });
});
router.delete('/prices/:id', async (req, res) => { await Price.updateOne({ _id: objectId.parse(req.params.id), business: req.business._id }, { active: false }); res.json({ ok: true }); });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
router.post('/photos', activeSubscription, upload.single('photo'), async (req, res) => {
  if (!req.file) fail(400, 'Choose a clothing photo.');
  let data;
  try { data = await sharp(req.file.buffer, { limitInputPixels: 40000000 }).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer(); }
  catch { fail(400, 'Upload a valid JPEG, PNG, or WebP image.'); }
  const photo = await Photo.create({ business: req.business._id, data, mime: 'image/jpeg' }); res.status(201).json({ id: photo._id });
});
router.get('/photos/:id', async (req, res) => {
  const photo = await Photo.findOne({ _id: objectId.parse(req.params.id), business: req.business._id }).select('+data');
  if (!photo) fail(404, 'Photo not found.'); res.set('Cache-Control', 'private, no-store').type(photo.mime).send(photo.data);
});
router.get('/orders', async (req, res) => res.json({ orders: await Order.find({ business: req.business._id }).populate('customer', 'name phone email').sort({ createdAt: -1 }).limit(500) }));
router.post('/orders', activeSubscription, async (req, res) => {
  const data = z.object({ customer: objectId, dueDate: z.iso.date(), notes: optionalText, conditionAcknowledged: z.boolean(), items: z.array(z.object({ priceId: objectId, quantity: z.number().int().min(1).max(100), condition: z.string().trim().min(1).max(1000), photos: z.array(objectId).max(5).default([]) })).min(1).max(50) }).parse(req.body);
  if (!await Customer.exists({ _id: data.customer, business: req.business._id })) fail(404, 'Customer not found.');
  const ids = [...new Set(data.items.flatMap(i => i.photos))];
  if (await Photo.countDocuments({ _id: { $in: ids }, business: req.business._id }) !== ids.length) fail(400, 'A clothing photo is invalid.');
  const calculated = priceItems(data.items, await Price.find({ business: req.business._id, active: true }));
  const trackingToken = token();
  const order = await Order.create({ ...data, ...calculated, business: req.business._id, reference: reference('FB'), trackingToken, history: [{ status: 'Dropped off', at: new Date(), actor: req.user._id }] });
  res.status(201).json({ order, trackingUrl: `${appUrl()}/track/${trackingToken}` });
});
router.get('/orders/:id', async (req, res) => {
  const order = await Order.findOne({ _id: objectId.parse(req.params.id), business: req.business._id }).select('+trackingToken').populate('customer');
  if (!order) fail(404, 'Order not found.'); res.json({ order, payments: await Payment.find({ order: order._id, status: 'paid' }), trackingUrl: `${appUrl()}/track/${order.trackingToken}` });
});
router.patch('/orders/:id/status', async (req, res) => {
  const { status } = z.object({ status: z.enum(STATUSES) }).parse(req.body);
  const order = await Order.findOne({ _id: objectId.parse(req.params.id), business: req.business._id });
  if (!order) fail(404, 'Order not found.');
  if (!validTransition(order.status, status, order.items)) fail(409, 'That is not the next stage for this order.');
  const updated = await Order.findOneAndUpdate({ _id: order._id, business: req.business._id, status: order.status }, { $set: { status }, $push: { history: { status, at: new Date(), actor: req.user._id } } }, { new: true });
  if (!updated) fail(409, 'Order changed. Refresh and try again.'); res.json({ order: updated });
});
router.get('/finance', async (req, res) => res.json({ payments: await Payment.find({ business: req.business._id, status: 'paid' }).sort({ createdAt: -1 }), expenses: await Expense.find({ business: req.business._id }).sort({ date: -1 }) }));
router.post('/expenses', activeSubscription, async (req, res) => {
  const data = z.object({ supplier: short, description: short, amount: money, date: z.iso.date(), method: z.enum(['Bank transfer', 'Cash', 'Card']) }).parse(req.body);
  res.status(201).json({ expense: await Expense.create({ ...data, business: req.business._id }) });
});
// Manual records deliberately remain distinguishable from provider-confirmed payments.
router.post('/orders/:id/payment', async (req, res) => {
  const data = z.object({ channel: z.enum(['Cash', 'Bank transfer']), note: z.string().trim().max(300).default('') }).parse(req.body);
  const order = await Order.findOne({ _id: objectId.parse(req.params.id), business: req.business._id });
  if (!order) fail(404, 'Order not found.');
  if (await Payment.exists({ order: order._id, status: { $in: ['paid', 'pending'] } })) fail(409, 'This order already has a payment or pending checkout.');
  const payment = await Payment.create({ ...data, business: req.business._id, order: order._id, kind: 'order', amount: order.total, reference: `ORDER-${order._id}`, status: 'paid' });
  res.status(201).json({ payment });
});
router.post('/subscription', async (req, res) => {
  const referenceId = reference('SUB');
  const checkout = await paystack('/transaction/initialize', { email: req.user.email, amount: 100000, currency: 'NGN', reference: referenceId, callback_url: `${appUrl()}/dashboard?payment=${referenceId}` });
  await Payment.create({ business: req.business._id, kind: 'subscription', amount: 100000, reference: referenceId, channel: 'Paystack' });
  res.json({ url: checkout.authorization_url });
});

app.get('/api/overview', auth, async (req, res) => {
  const businesses = await Business.find({ owner: req.user._id, archived: false }); const ids = businesses.map(b => b._id);
  res.json({ businesses, customers: await Customer.find({ business: { $in: ids } }).sort({ name: 1 }), orders: await Order.find({ business: { $in: ids } }).populate('customer', 'name phone').sort({ createdAt: -1 }), payments: await Payment.find({ business: { $in: ids }, status: 'paid' }), expenses: await Expense.find({ business: { $in: ids } }) });
});
app.get('/api/directory', async (req, res) => {
  const businesses = await Business.find({ archived: false, listed: true }).select('name city state address phone description').sort({ name: 1 }).limit(200);
  res.json({ businesses });
});
app.get('/api/directory/:businessId', async (req, res) => {
  if (!/^[a-f\d]{24}$/i.test(req.params.businessId)) fail(404, 'Business not found.');
  const business = await Business.findOne({ _id: req.params.businessId, archived: false, listed: true }).select('name city state address phone description notice').lean();
  if (!business) fail(404, 'Business not found.');
  const prices = await Price.find({ business: business._id, active: true }).select('category service amount').sort({ category: 1, _id: 1 });
  res.set('Cache-Control', 'no-store').json({ business, services: groupPrices(prices).map(({ _id, ...service }) => service) });
});
async function tracked(raw) {
  if (!/^[a-f0-9]{64}$/.test(raw)) fail(404, 'Tracking link not found.');
  const order = await Order.findOne({ trackingToken: raw }).populate('business', 'name address phone notice bankName accountName accountNumber archived');
  if (!order || !order.business || order.business.archived) fail(404, 'Tracking link not found.');
  return order;
}
app.get('/api/track/:token', async (req, res) => {
  const order = await tracked(req.params.token);
  const paid = !!await Payment.exists({ order: order._id, status: 'paid' });
  res.set('Cache-Control', 'no-store').json({ order: { reference: order.reference, status: order.status, total: order.total, dueDate: order.dueDate, createdAt: order.createdAt, items: order.items.map(({ category, service, quantity, unitAmount }) => ({ category, service, quantity, unitAmount })), history: order.history.map(({ status, at }) => ({ status, at })), business: order.business, paid }, paymentsEnabled: process.env.ORDER_PAYMENTS_ENABLED === 'true' && !!subaccount(order.business._id) });
});
const subaccount = id => { try { return JSON.parse(process.env.PAYSTACK_SUBACCOUNTS || '{}')[String(id)]; } catch { return undefined; } };
app.post('/api/track/:token/pay', async (req, res) => {
  const order = await tracked(req.params.token);
  const data = z.object({ email }).parse(req.body);
  if (process.env.ORDER_PAYMENTS_ENABLED !== 'true' || !subaccount(order.business._id)) fail(503, 'Online collections are not enabled for this business.');
  const referenceId = `ORDER-${order._id}`;
  const existing = await Payment.findOne({ reference: referenceId });
  if (existing?.status === 'paid') fail(409, 'This order is already paid.');
  // Reserve one immutable reference per order to prevent concurrent duplicate checkouts.
  if (existing) fail(409, 'A checkout already exists. Contact the business to reconcile it before retrying.');
  await Payment.create({ business: order.business._id, order: order._id, kind: 'order', amount: order.total, reference: referenceId, channel: 'Paystack' });
  const checkout = await paystack('/transaction/initialize', { email: data.email, amount: order.total, currency: 'NGN', reference: referenceId, subaccount: subaccount(order.business._id), transaction_charge: 0, bearer: 'subaccount', callback_url: `${appUrl()}/track/${req.params.token}?payment=${referenceId}` });
  res.json({ url: checkout.authorization_url });
});
async function settlePayment(referenceId) {
  if (typeof referenceId !== 'string' || referenceId.length > 100) fail(400, 'Invalid payment reference.');
  const payment = await Payment.findOne({ reference: referenceId });
  if (!payment) return;
  if (payment.status === 'paid') return payment;
  const verified = await paystack(`/transaction/verify/${encodeURIComponent(referenceId)}`);
  if (verified.status !== 'success' || verified.currency !== 'NGN' || verified.amount !== payment.amount || verified.reference !== referenceId) fail(409, 'Payment is not confirmed or the amount does not match.');
  // MongoDB transaction keeps subscription extension and payment settlement atomic.
  const dbSession = await mongoose.startSession();
  try {
    await dbSession.withTransaction(async () => {
      const updated = await Payment.findOneAndUpdate({ _id: payment._id, status: 'pending' }, { status: 'paid' }, { new: true, session: dbSession });
      if (updated?.kind === 'subscription') {
        const business = await Business.findById(updated.business).session(dbSession);
        if (business) { business.subscriptionUntil = new Date(Math.max(Date.now(), business.subscriptionUntil?.getTime() || 0) + 30 * 86400000); await business.save({ session: dbSession }); }
      }
    });
  } finally { await dbSession.endSession(); }
  return Payment.findById(payment._id);
}
app.post('/api/payments/:reference/verify', auth, async (req, res) => {
  const payment = await Payment.findOne({ reference: req.params.reference });
  if (!payment || !await Business.exists({ _id: payment.business, owner: req.user._id })) fail(404, 'Payment not found.');
  res.json({ payment: await settlePayment(payment.reference) });
});
app.post('/api/track/:token/verify', async (req, res) => {
  const order = await tracked(req.params.token);
  const payment = await Payment.findOne({ order: order._id, channel: 'Paystack' });
  if (!payment) fail(404, 'Payment not found.'); res.json({ paid: (await settlePayment(payment.reference))?.status === 'paid' });
});
app.use((req, res) => res.status(404).json({ error: 'Endpoint not found.' }));
app.use((err, req, res, next) => {
  if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
  if (err.code === 11000) return res.status(409).json({ error: 'This record already exists. Check the email, phone number, or payment.' });
  if (err instanceof multer.MulterError) return res.status(400).json({ error: 'Photo must be smaller than 8 MB.' });
  const status = err.status || (err.name === 'CastError' || err instanceof SyntaxError ? 400 : 500);
  if (status >= 500) console.error(err.message);
  res.status(status).json({ error: status === 500 ? 'Something went wrong. Please try again.' : err.message });
});
export default app;
