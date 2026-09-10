import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { rateLimit } from 'express-rate-limit';
import { configureProxy } from '../src/proxy.js';

test('direct local access ignores client-supplied forwarding headers', async () => {
  const app = express(); configureProxy(app, {});
  app.get('/', (req, res) => res.json({ ip: req.ip }));
  assert.equal(app.get('trust proxy'), false);
  const response = await request(app).get('/').set('X-Forwarded-For', '198.51.100.1');
  assert.notEqual(response.body.ip, '198.51.100.1');
});
test('Render rate limiting trusts the nearest forwarded address, not spoofed prefixes', async () => {
  const app = express(); configureProxy(app, { RENDER: 'true' });
  app.use(rateLimit({ windowMs: 60000, limit: 1, standardHeaders: 'draft-8', legacyHeaders: false }));
  app.get('/', (req, res) => res.json({ ip: req.ip }));
  assert.equal(app.get('trust proxy'), 1);
  const first = await request(app).get('/').set('X-Forwarded-For', '192.0.2.10, 198.51.100.1').expect(200);
  assert.equal(first.body.ip, '198.51.100.1');
  await request(app).get('/').set('X-Forwarded-For', '192.0.2.20, 198.51.100.1').expect(429);
  await request(app).get('/').set('X-Forwarded-For', '198.51.100.2').expect(200);
});
test('explicit proxy configuration overrides platform detection', () => {
  const app = express();
  configureProxy(app, { RENDER: 'true', TRUST_PROXY_HOPS: '0' });
  assert.equal(app.get('trust proxy'), false);
  configureProxy(app, { TRUST_PROXY_HOPS: '1' });
  assert.equal(app.get('trust proxy'), 1);
});
test('unrestricted or unreviewed proxy trust fails at startup', () => {
  for (const value of ['true', '2', '-1', 'anything']) assert.throws(() => configureProxy(express(), { TRUST_PROXY_HOPS: value }), /TRUST_PROXY_HOPS/);
});
