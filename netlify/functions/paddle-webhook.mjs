// Receives Paddle webhooks. On transaction.completed for the cookbook price,
// records the transaction ID as paid so /api/download will serve the PDF.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getStore } from '@netlify/blobs';

const PRICE_ID = 'pri_01m3cnmvbdeb542pmtxvrdm919';
const MAX_AGE_SECONDS = 5 * 60; // reject old, replayed webhooks

// Paddle-Signature: "ts=1671552777;h1=abc..." (several h1 values while a secret is rotated)
function isValidSignature(rawBody, header, secret) {
  let ts = '';
  const hashes = [];
  for (const part of header.split(';')) {
    const [key, value] = part.split('=');
    if (key === 'ts') ts = value;
    if (key === 'h1' && value) hashes.push(value);
  }
  if (!ts || !hashes.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > MAX_AGE_SECONDS) return false;

  const expected = createHmac('sha256', secret).update(`${ts}:${rawBody}`).digest();
  return hashes.some(h => {
    const given = Buffer.from(h, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

export default async req => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const secret = process.env.PADDLE_WEBHOOK_SECRET;
  if (!secret) return new Response('Webhook secret not configured', { status: 500 });

  const rawBody = await req.text();
  if (!isValidSignature(rawBody, req.headers.get('paddle-signature') || '', secret)) {
    return new Response('Invalid signature', { status: 401 });
  }

  const event = JSON.parse(rawBody);
  if (event.event_type === 'transaction.completed') {
    const txn = event.data;
    const boughtBook = (txn.items || []).some(item => item.price?.id === PRICE_ID);
    if (boughtBook) {
      await getStore('orders').setJSON(txn.id, {
        paidAt: event.occurred_at,
        customerId: txn.customer_id,
      });
    }
  }

  return new Response('ok');
};

export const config = { path: '/api/paddle-webhook' };
