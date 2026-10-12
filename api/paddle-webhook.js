// Receives Paddle webhooks and verifies the signature.
//
// The download no longer depends on this running — api/download.js asks Paddle
// directly whether a transaction was paid — so a failure here can no longer
// stop a buyer getting their book. This endpoint stays as the hook for the
// post-purchase confirmation email, and so Paddle's delivery log shows 200.
//
// Environment:
//   PADDLE_WEBHOOK_SECRET  signing secret of the notification destination
//                          (the pdl_ntfset_-prefixed secret, NOT the ntfset_ id)
export const config = { runtime: 'edge' };

const PRICE_ID = 'pri_01m3cnmvbdeb542pmtxvrdm919';
const MAX_AGE_SECONDS = 5 * 60; // reject old, replayed webhooks

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

// Constant-time compare, so a wrong signature cannot be guessed byte by byte.
function sameHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Paddle-Signature: "ts=1671552777;h1=abc..." (several h1 values while a secret is rotated)
async function isValidSignature(rawBody, header, secret) {
  let ts = '';
  const hashes = [];
  for (const part of header.split(';')) {
    const [key, value] = part.split('=');
    if (key === 'ts') ts = value;
    if (key === 'h1' && value) hashes.push(value);
  }
  if (!ts || !hashes.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > MAX_AGE_SECONDS) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const expected = hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${ts}:${rawBody}`)));
  return hashes.some(h => sameHex(h, expected));
}

export default async function handler(request) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const secret = process.env.PADDLE_WEBHOOK_SECRET;
  if (!secret) return new Response('Webhook secret not configured', { status: 500 });

  const rawBody = await request.text();
  const header = request.headers.get('paddle-signature') || '';
  if (!(await isValidSignature(rawBody, header, secret))) {
    return new Response('Invalid signature', { status: 401 });
  }

  const event = JSON.parse(rawBody);
  if (event.event_type === 'transaction.completed') {
    const txn = event.data;
    const boughtBook = (txn.items || []).some(item => item.price?.id === PRICE_ID);
    if (boughtBook) {
      // Hook point for the confirmation email. Deliberately not fatal: if sending
      // ever fails we still return 200, because a retry storm here would do
      // nothing useful now that the download does not depend on this record.
      console.log('paid', txn.id, 'customer', txn.customer_id);
    }
  }

  return new Response('ok');
}
