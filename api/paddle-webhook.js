// Receives Paddle webhooks, verifies the signature, and emails the buyer their
// receipt with the cookbook attached.
//
// The download does not depend on this running — api/download.js asks Paddle
// directly whether a transaction was paid — so a failure here can never stop
// someone getting their book. This is the second delivery route, for the case
// that stranded the 12 Oct buyer: she paid, never reached the download page,
// and Paddle's own receipt carries no link to it.
//
// Everything after signature verification is best-effort and the handler still
// returns 200. A non-2xx would make Paddle retry for days, which would send
// duplicate emails without fixing anything.
//
// Environment:
//   PADDLE_WEBHOOK_SECRET  signing secret of the notification destination
//                          (the pdl_ntfset_-prefixed secret, NOT the ntfset_ id)
//   PADDLE_API_KEY         server-side key, used to look up the buyer's email
//   BREVO_API_KEY          Brevo transactional email key
//   PDF_PRIVATE_URL        optional — derived from BLOB_STORE_ID when unset
//   VERCEL_OIDC_TOKEN      injected and rotated by Vercel; authenticates the blob read
export const config = { runtime: 'edge' };

const PRICE_ID = 'pri_01m3cnmvbdeb542pmtxvrdm919';
const MAX_AGE_SECONDS = 5 * 60; // reject old, replayed webhooks
const SITE = 'https://www.haroldcooks.com';
const FROM = { name: 'Grandpa Harold Cooks', email: 'hello@haroldcooks.com' };
const FILENAME = 'Frugal-Jewish-Kitchen-Harold-Rosenberg-2026.pdf';

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

// The transaction.completed payload carries customer_id, not the address.
async function buyerEmail(txn) {
  if (txn.customer?.email) return txn.customer.email;
  const apiKey = (process.env.PADDLE_API_KEY || '').trim().replace(/^Bearer\s+/i, '');
  if (!apiKey || !txn.customer_id) return null;
  const r = await fetch(`https://api.paddle.com/customers/${txn.customer_id}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!r.ok) return null;
  return (await r.json())?.data?.email || null;
}

// Private blobs live at https://<store-id>.private.blob.vercel-storage.com/<pathname>,
// and BLOB_STORE_ID is injected automatically when the store is connected to the
// project — so the URL can be derived and usually needs no configuring. The id
// carries a "store_" prefix that the hostname does not. PDF_PRIVATE_URL overrides
// the whole thing if the derived form is ever wrong.
function privatePdfUrl() {
  if (process.env.PDF_PRIVATE_URL) return process.env.PDF_PRIVATE_URL.trim();
  const id = (process.env.BLOB_STORE_ID || '').trim().replace(/^store_/, '');
  if (!id) return null;
  const pathname = (process.env.PDF_PATHNAME || 'cookbook.pdf').replace(/^\/+/, '');
  return `https://${id}.private.blob.vercel-storage.com/${pathname}`;
}

// Private blobs have no public URL; read them with the OIDC token Vercel injects.
async function pdfBase64() {
  const url = privatePdfUrl();
  const token = process.env.VERCEL_OIDC_TOKEN || process.env.BLOB_READ_WRITE_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const bytes = new Uint8Array(await r.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function body(link) {
  return `<div style="font-family:Georgia,serif;font-size:16px;line-height:1.6;color:#231A12;max-width:520px">
  <p>Thank you for buying <i>Frugal Jewish Kitchen That Saves You Money</i>.</p>
  <p>Your copy is attached to this email, so it is yours to keep. You can also
     download it again at any time from this link:</p>
  <p><a href="${link}" style="color:#9A2E1B">Download your cookbook</a></p>
  <p>If the attachment does not open or the link stops working, just reply to this
     email and we will send it straight over.</p>
  <p>Enjoy the cooking.<br>— Grandpa Harold Cooks</p>
</div>`;
}

async function sendReceipt(txn) {
  const apiKey = (process.env.BREVO_API_KEY || '').trim();
  if (!apiKey) return 'no_brevo_key';

  const to = await buyerEmail(txn);
  if (!to) return 'no_email';

  const link = `${SITE}/download?txn=${encodeURIComponent(txn.id)}`;
  const pdf = await pdfBase64();

  const payload = {
    sender: FROM,
    to: [{ email: to }],
    subject: 'Your cookbook is here',
    htmlContent: body(link),
    ...(pdf ? { attachment: [{ content: pdf, name: FILENAME }] } : {}),
  };

  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
  });
  // Deliberately not fatal: the buyer can still download, so a mail outage must
  // not turn into a Paddle retry storm.
  return r.ok ? (pdf ? 'sent_with_pdf' : 'sent_link_only') : `brevo_${r.status}`;
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

  try {
    const event = JSON.parse(rawBody);
    if (event.event_type === 'transaction.completed') {
      const txn = event.data;
      if ((txn.items || []).some(i => i.price?.id === PRICE_ID)) {
        console.log('receipt', txn.id, await sendReceipt(txn));
      }
    }
  } catch (err) {
    console.error('webhook handling failed', err);
  }

  return new Response('ok');
}
