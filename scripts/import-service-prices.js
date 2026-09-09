import mongoose from 'mongoose';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Business, Price } from '../src/models.js';
import { categoryKey, groupPrices, savePriceGroup } from '../src/pricing.js';
import { requestedPrices } from './requested-prices.js';
const value = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const id = value('business'), expectedName = value('expected-name');
if (!/^[a-f\d]{24}$/i.test(id || '') || !expectedName) throw new Error('Provide --business=MONGO_ID and --expected-name=EXACT_BUSINESS_NAME.');
const imported = requestedPrices(value('combined'));
const aliases = { SHIRTS: 'SHIRT' };
try {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  const business = await Business.findOne({ _id: id, archived: false });
  if (!business || business.name !== expectedName) throw new Error('Business does not match the requested import target.');
  const previous = await Price.find({ business: id }).sort({ _id: 1 }).lean();
  const groups = groupPrices(previous.filter(p => p.active));
  const match = (list, category) => list.find(group => categoryKey(group.category) === categoryKey(category)) || list.find(group => categoryKey(group.category) === aliases[categoryKey(category)]);
  console.log(JSON.stringify({ business: business.name, businessId: id, combinedPrices: value('combined'), washOnlyFootwearAndBags: true, clothingTypes: imported.length, changes: imported.map(item => ({ ...item, action: match(groups, item.category) ? 'update' : 'add' })), amounts: 'integer kobo' }, null, 2));
  if (!process.argv.includes('--apply')) console.log('Dry run only. Add --apply to import.');
  else {
    const backupDir = fileURLToPath(new URL('../../.cache/pricing-backups/', import.meta.url));
    await mkdir(backupDir, { recursive: true });
    const backupPath = `${backupDir}${id}-${Date.now()}.json`;
    await writeFile(backupPath, JSON.stringify({ businessId: id, businessName: business.name, prices: previous }, null, 2), { flag: 'wx' });
    await mongoose.connection.transaction(async session => {
      // Acquire the same business lock as normal pricing edits, then re-read.
      const locked = await Business.findOneAndUpdate({ _id: id, name: expectedName, archived: false }, { $inc: { pricingRevision: 1 } }, { session });
      if (!locked) throw new Error('Business changed before the import.');
      for (const item of imported) {
        const current = groupPrices(await Price.find({ business: id, active: true }).sort({ _id: 1 }).session(session));
        await savePriceGroup(id, item, match(current, item.category)?._id, session);
      }
    });
    const actual = groupPrices(await Price.find({ business: id, active: true }).sort({ _id: 1 }));
    for (const item of imported) {
      const found = match(actual, item.category);
      if (!found || ['wash', 'iron', 'washIron'].some(field => found[field] !== item[field])) throw new Error(`Verification failed for ${item.category}`);
    }
    console.log(JSON.stringify({ importedAndVerified: imported.length, totalActiveClothingTypes: actual.length, backupPath }));
  }
} catch (error) { console.error(error.name === 'MongoServerSelectionError' ? 'Database connection unavailable.' : error.message); process.exitCode = 1; }
finally { await mongoose.disconnect(); }
