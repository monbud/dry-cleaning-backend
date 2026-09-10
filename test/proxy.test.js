import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { createRateLimiter } from '../src/rate-limit.js';
import { configureProxy } from '../src/proxy.js';

test('direct local access ignores client-supplied forwarding headers', async () => {
  const app = express(); configureProxy(app, {});
  app.get('/', (req, res) => res.json({ ip: req.ip }));
  assert.equal(app.get('trust proxy'), false);
  const response = await request(app).get('/').set('X-Forwarded-For', '198.51.100.1');
  assert.notEqual(response.body.ip, '198.51.100.1');
});
test('Render rate limiting ignores Forwarded and spoofed X-Forwarded-For prefixes without warnings', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const app = express(); configureProxy(app, { RENDER: 'true' });
  app.use(createRateLimiter({ windowMs: 60000, limit: 1 }));
  app.get('/', (req, res) => res.json({ ip: req.ip }));
  assert.equal(app.get('trust proxy'), 1);
  const first = await request(app).get('/').set('Forwarded', 'for=192.0.2.10;proto=https').set('X-Forwarded-For', '192.0.2.10, 198.51.100.1').expect(200);
  assert.equal(first.body.ip, '198.51.100.1');
  await request(app).get('/').set('Forwarded', 'for=192.0.2.20;proto=https').set('X-Forwarded-For', '192.0.2.20, 198.51.100.1').expect(429);
  await request(app).get('/').set('X-Forwarded-For', '198.51.100.2').expect(200);
  assert.equal(errors.mock.callCount(), 0);
});
test('explicit proxy configuration supports direct and proxied access', () => {
  const app = express();
  configureProxy(app, { TRUST_PROXY_HOPS: '0' });
  assert.equal(app.get('trust proxy'), false);
  configureProxy(app, { TRUST_PROXY_HOPS: '1' });
  assert.equal(app.get('trust proxy'), 1);
});
test('unrestricted or unreviewed proxy trust fails at startup', () => {
  assert.throws(() => configureProxy(express(), { RENDER: 'true', TRUST_PROXY_HOPS: '0' }), /Render requires TRUST_PROXY_HOPS=1/);
  for (const value of ['true', '2', '-1', 'anything']) assert.throws(() => configureProxy(express(), { TRUST_PROXY_HOPS: value }), /TRUST_PROXY_HOPS/);
});
