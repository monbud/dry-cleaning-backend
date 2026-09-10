import mongoose from 'mongoose';
import app from './app.js';
console.log(`[proxy-config-v2] trust proxy=${app.get('trust proxy')}; Render=${process.env.RENDER === 'true'}; source=${process.env.TRUST_PROXY_HOPS === undefined ? 'automatic' : 'TRUST_PROXY_HOPS'}; rate-limit header=X-Forwarded-For`);
if (!process.env.MONGODB_URI) throw new Error('Set MONGODB_URI in backend/.env before starting.');
if (process.env.NODE_ENV === 'production' && !process.env.APP_URL?.startsWith('https://')) throw new Error('Production APP_URL must use HTTPS.');
await mongoose.connect(process.env.MONGODB_URI);
const server = app.listen(process.env.PORT || 4000, '0.0.0.0', () => console.log(`FinBud API listening on port ${process.env.PORT || 4000}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(async () => { await mongoose.disconnect(); process.exit(0); }));
