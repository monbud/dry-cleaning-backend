export function configureProxy(app, env = process.env) {
  // Render's public ingress is the immediate trusted proxy. Local servers
  // must not trust forwarding headers from clients connecting directly.
  const hops = env.TRUST_PROXY_HOPS ?? (env.RENDER === 'true' ? '1' : '0');
  if (!['0', '1'].includes(hops)) throw new Error('TRUST_PROXY_HOPS must be 0 (direct access) or 1 (one trusted ingress proxy).');
  if (env.RENDER === 'true' && hops === '0') throw new Error('Render requires TRUST_PROXY_HOPS=1. Remove the TRUST_PROXY_HOPS=0 override or change it to 1.');
  app.set('trust proxy', hops === '1' ? 1 : false);
}
