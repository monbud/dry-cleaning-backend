// Local-only, disposable preview. Never run this script on a public server.
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import app from '../src/app.js';
import { User, Business, Customer, Price, Order, Payment, Expense } from '../src/models.js';
import { token, reference } from '../src/domain.js';
if (process.env.NODE_ENV === 'production') throw new Error('The disposable demo cannot run in production.');
process.env.APP_URL ||= 'http://localhost:3000';
process.env.ORDER_PAYMENTS_ENABLED = 'false';
delete process.env.PAYSTACK_SECRET_KEY;
delete process.env.MAILJET_API_KEY;
const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
await mongoose.connect(mongo.getUri());
const user = await User.create({ name: 'Ada Okafor', email: 'demo@finbud.example', password: await bcrypt.hash('FreshStart2026!', 12) });
const business = await Business.create({ owner: user._id, name: 'The Neat House', city: 'Lekki', state: 'Lagos', address: '12 Example Lane, Lekki (fictional demo address)', phone: '+2348000000000', description: 'Fictional preview business. Thoughtful garment care, from everyday shirts to special occasions.', notice: 'Demo business — sample records only. Collection hours: Monday–Saturday, 9am–6pm.', listed: true, subscriptionUntil: new Date(Date.now() + 14 * 86400000) });
const categories = [['Shirt',150000],['Trousers',150000],['Dress',250000],['Agbada',500000],['Duvet',600000],['Two-piece suit',400000]];
const prices = await Price.insertMany(categories.map(([category,amount]) => ({ business: business._id, category, service: 'Wash & iron', amount })));
const names = ['Tolu Adeyemi','Chinedu Obi','Zainab Bello','Emeka Nwosu','Funke Williams','Ibrahim Musa','Amaka Okoye','David Akinola'];
for (let i = 0; i < names.length; i++) {
  const customer = await Customer.create({ business: business._id, name: names[i], phone: `+234800000000${i + 1}`, email: `customer${i + 1}@example.com` });
  const price = prices[i % prices.length];
  const stage = [0,3,1,2,0,4,1,3][i]; const stages = ['Dropped off','Washing','Ironing','Ready for pickup','Collected'];
  const createdAt = new Date(Date.now() - (i + 1) * 86400000);
  const order = await Order.create({ business: business._id, customer: customer._id, reference: reference('FB'), trackingToken: token(), items: [{ category: price.category, service: price.service, quantity: i % 3 + 1, unitAmount: price.amount, condition: i % 2 ? 'No visible damage. Buttons and seams checked together.' : 'Light mark near the collar. No tears observed.', photos: [] }], total: price.amount * (i % 3 + 1), status: stages[stage], dueDate: new Date(Date.now() + (i % 3) * 86400000), conditionAcknowledged: true, history: stages.slice(0, stage + 1).map((status, index) => ({ status, at: new Date(createdAt.getTime() + index * 3600000), actor: user._id })), createdAt });
  if (i % 3 !== 0) await Payment.create({ business: business._id, order: order._id, kind: 'order', amount: order.total, reference: `ORDER-${order._id}`, channel: i % 2 ? 'Bank transfer' : 'Cash', status: 'paid' });
}
await Expense.insertMany([{ supplier: 'Fresh Supplies (demo)', description: 'Detergent and garment bags', amount: 1800000, method: 'Bank transfer' }, { supplier: 'Power (demo)', description: 'Electricity top-up', amount: 1000000, method: 'Bank transfer' }].map(e => ({ ...e, business: business._id, date: new Date() })));
const server = app.listen(Number(process.env.PORT || 4000), '127.0.0.1', () => console.log(`Disposable demo API ready\nOpen ${process.env.APP_URL}/login\nEmail: demo@finbud.example\nPassword: FreshStart2026!\nAll demo records disappear when this process stops.`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(async () => { await mongoose.disconnect(); await mongo.stop(); process.exit(0); }));
