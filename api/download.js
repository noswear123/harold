// Serves the cookbook PDF, but only for a transaction Paddle confirms was paid.
//
//   GET /api/download?txn=txn_...&check=1  -> { ready: true|false }
//   GET /api/download?txn=txn_...          -> the PDF
//
// Entitlement is checked against the Paddle API directly rather than against a
// record written by the webhook. That matters: on 12 Oct a buyer paid, the
// webhook was delivered and the order was recorded, yet she never reached this
// page and had no way to get her book. Asking Paddle at download time means the
// download works whenever the payment is real, even if the webhook never
// arrives, is delayed, or the signing secret is wrong.
//
// Environment:
//   PADDLE_API_KEY  server-side key, used to look the transaction up
//   PDF_URL         unguessable URL of the PDF (Vercel Blob), never public here
export const config = { runtime: 'edge' };

const PRICE_ID = 'pri_01m3cnmvbdeb542pmtxvrdm919';
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

  const pdfUrl = process.env.PDF_URL;
  if (!pdfUrl) return new Response(`The cookbook file is temporarily unavailable. ${HELP}`, { status: 500 });

  const pdf = await fetch(pdfUrl, { cache: 'no-store' });
  if (!pdf.ok) return new Response(`The cookbook file is temporarily unavailable. ${HELP}`, { status: 500 });

  return new Response(pdf.body, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${FILENAME}"`,
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex',
    },
  });
}
