import mongoose from 'mongoose';
import { Business, Price } from './models.js';

export const serviceFields = { wash: 'Wash only', iron: 'Iron only', washIron: 'Wash & iron' };
export const categoryKey = value => value.trim().replace(/\s+/g, ' ').toUpperCase();
export function groupPrices(prices) {
  const groups = new Map();
  for (const price of prices) {
    const key = categoryKey(price.category);
    if (!groups.has(key)) groups.set(key, { _id: price._id, category: price.category, wash: null, iron: null, washIron: null });
    const field = Object.keys(serviceFields).find(field => serviceFields[field] === price.service);
    if (field && groups.get(key)[field] === null) groups.get(key)[field] = price.amount;
  }
  return [...groups.values()].sort((a, b) => a.category.localeCompare(b.category));
}
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
// Lock the business in the transaction so concurrent group edits cannot create duplicates.
export async function savePriceGroup(businessId, input, id, existingSession) {
  const save = async session => {
    const business = await Business.findOneAndUpdate({ _id: businessId, archived: false }, { $inc: { pricingRevision: 1 } }, { session });
    if (!business) fail(404, 'Business not found.');
    const active = await Price.find({ business: businessId, active: true }).sort({ _id: 1 }).session(session);
    const anchor = id ? active.find(p => String(p._id) === String(id)) : null;
    if (id && !anchor) fail(404, 'Clothing type not found.');
    const previousKey = anchor ? categoryKey(anchor.category) : null;
    const newKey = categoryKey(input.category);
    if (active.some(p => categoryKey(p.category) === newKey && categoryKey(p.category) !== previousKey)) fail(409, 'This clothing type already exists. Edit its prices instead.');
    const previous = active.filter(p => categoryKey(p.category) === previousKey);
    await Price.updateMany({ business: businessId, _id: { $in: previous.map(p => p._id) } }, { active: false }, { session });
    const saved = [];
    for (const [field, service] of Object.entries(serviceFields)) {
      const amount = input[field];
      if (amount === null || amount === undefined) continue;
      const existing = previous.find(p => p.service === service);
      if (existing) saved.push(await Price.findOneAndUpdate({ _id: existing._id, business: businessId }, { category: input.category.trim().replace(/\s+/g, ' '), service, amount, active: true }, { new: true, session }));
      else saved.push(...await Price.create([{ business: businessId, category: input.category.trim().replace(/\s+/g, ' '), service, amount, active: true }], { session }));
    }
    return groupPrices(saved)[0];
  };
  return existingSession ? save(existingSession) : mongoose.connection.transaction(save);
}
export async function removePriceGroup(businessId, id) {
  return mongoose.connection.transaction(async session => {
    await Business.updateOne({ _id: businessId }, { $inc: { pricingRevision: 1 } }, { session });
    const active = await Price.find({ business: businessId, active: true }).session(session);
    const anchor = active.find(p => String(p._id) === String(id));
    if (!anchor) fail(404, 'Clothing type not found.');
    const ids = active.filter(p => categoryKey(p.category) === categoryKey(anchor.category)).map(p => p._id);
    await Price.updateMany({ business: businessId, _id: { $in: ids } }, { active: false }, { session });
  });
}
