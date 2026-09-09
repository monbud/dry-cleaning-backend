export async function sendReset(email, url) {
  const { MAILJET_API_KEY: key, MAILJET_SECRET_KEY: secret, MAIL_FROM: from } = process.env;
  if (!key || !secret || !from) throw Object.assign(new Error('Password reset email is not configured. Contact the platform administrator.'), { status: 503 });
  const response = await fetch('https://api.mailjet.com/v3.1/send', { method: 'POST', signal: AbortSignal.timeout(15000), headers: { Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ Messages: [{ From: { Email: from, Name: 'FinBud' }, To: [{ Email: email }], Subject: 'Reset your FinBud password', TextPart: `Reset your password using this link within 30 minutes: ${url}\nIf you did not request this, ignore this email.` }] }) });
  if (!response.ok) throw Object.assign(new Error('Unable to send email. Please try again later.'), { status: 503 });
}
export async function paystack(path, body) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret || (!secret.startsWith('sk_test_') && process.env.ALLOW_LIVE_PAYMENTS !== 'true')) throw Object.assign(new Error('Payments are not configured. Contact the business.'), { status: 503 });
  const response = await fetch(`https://api.paystack.co${path}`, { method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(20000), headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok || !result.status) throw Object.assign(new Error('Payment provider unavailable. Please try again.'), { status: 502 });
  return result.data;
}
