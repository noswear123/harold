// Serves the cookbook PDF, but only for a transaction Paddle confirms was paid.
//
//   GET /api/download?txn=txn_...&check=1  -> { ready: true|false }
//   GET /api/download?txn=txn_...          -> the PDF
//
// Two things worth knowing about how this works:
//
// 1. Entitlement is checked against the Paddle API directly, not against a
//    record written by the webhook. On 12 Oct a buyer paid, the webhook was
//    delivered and the order was recorded, yet she never reached the download
//    page and had no way to get her book. Asking Paddle at download time means
//    the download works whenever the payment is real, even if the webhook is
//    late, misconfigured, or never arrives at all.
//
// 2. The PDF lives in a PRIVATE Vercel Blob store, so it has no publicly
//    fetchable URL. It can only be read through this function, after the
//    payment check above has passed. Authentication is OIDC, which Vercel wires
//    up automatically once the store is connected to the project.
//
// Environment:
//   PADDLE_API_KEY   server-side Paddle key, used to look the transaction up
//   BLOB_STORE_ID    added automatically when the Blob store is connected
//   VERCEL_OIDC_TOKEN added and rotated automatically by Vercel
import { get } from '@vercel/blob';

export const config = { runtime: 'edge' };

const PRICE_ID = 'pri_01m3cnmvbdeb542pmtxvrdm919';
const PDF_PATHNAME = process.env.PDF_PATHNAME || 'cookbook.pdf';
const FILENAME = 'Frugal-Jewish-Kitchen-Harold-Rosenberg-2026.pdf';
const HELP = 'Please email hello@haroldcooks.com with your Paddle receipt and we will send your cookbook.';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

async function isPaid(txn, apiKey) {
  const r = await fetch(`https://api.paddle.com/transactions/${txn}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!r.ok) return false;
  const { data } = await r.json();
  if (!data || data.status !== 'completed') return false;
  return (data.items || []).some(i => i.price?.id === PRICE_ID);
}

export default async function handler(request) {
  const url = new URL(request.url);
  const txn = url.searchParams.get('txn') || '';
  const checkOnly = url.searchParams.has('check');

  if (!/^txn_[a-z0-9]{20,40}$/.test(txn)) {
    return checkOnly
      ? json({ ready: false, error: 'invalid' }, 400)
      : new Response(`This download link is not valid. ${HELP}`, { status: 400 });
  }

  const apiKey = process.env.PADDLE_API_KEY;
  if (!apiKey) {
    return checkOnly
      ? json({ ready: false, error: 'not_configured' }, 500)
      : new Response(`The download is temporarily unavailable. ${HELP}`, { status: 500 });
  }

  if (!(await isPaid(txn, apiKey))) {
    return checkOnly
      ? json({ ready: false })
      : new Response(`We could not find a completed payment for this order yet. ${HELP}`, { status: 404 });
  }
  if (checkOnly) return json({ ready: true });

  // Paid and verified — now, and only now, read the private blob.
  const result = await get(PDF_PATHNAME, { access: 'private' });
  if (result?.statusCode !== 200) {
    return new Response(`The cookbook file is temporarily unavailable. ${HELP}`, { status: 500 });
  }

  return new Response(result.stream, {
    headers: {
      'Content-Type': result.blob.contentType || 'application/pdf',
      'Content-Disposition': `attachment; filename="${FILENAME}"`,
      'Cache-Control': 'private, no-cache',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex',
    },
  });
}
