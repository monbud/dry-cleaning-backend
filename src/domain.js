import crypto from 'node:crypto';
export const token = () => crypto.randomBytes(32).toString('hex');
export const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export const reference = prefix => `${prefix}-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
export function priceItems(items, prices) {
  const result = items.map(item => {
    const price = prices.find(p => String(p._id) === item.priceId && p.active);
    if (!price) throw Object.assign(new Error('A selected price is no longer available.'), { status: 400 });
    return { category: price.category, service: price.service, unitAmount: price.amount, quantity: item.quantity, condition: item.condition, photos: item.photos || [] };
  });
  return { items: result, total: result.reduce((sum, item) => sum + item.quantity * item.unitAmount, 0) };
}
export function validTransition(current, next, items) {
  const stages = ['Dropped off'];
  if (items.some(i => i.service !== 'Iron only')) stages.push('Washing');
  if (items.some(i => i.service !== 'Wash only')) stages.push('Ironing');
  stages.push('Ready for pickup', 'Collected');
  return stages[stages.indexOf(current) + 1] === next;
}
export function validWebhook(raw, signature, secret) {
  if (!secret || !/^[a-f0-9]{128}$/i.test(signature || '')) return false;
  const digest = crypto.createHmac('sha512', secret).update(raw).digest();
  return crypto.timingSafeEqual(digest, Buffer.from(signature, 'hex'));
}
