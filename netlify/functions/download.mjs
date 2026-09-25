// Serves the cookbook PDF, but only for a transaction ID that the Paddle
// webhook has recorded as paid. The PDF itself lives in Netlify Blobs
// (store "files", key "cookbook.pdf"), never in the public site.
//
//   GET /api/download?txn=txn_...&check=1  -> { ready: true|false }
//   GET /api/download?txn=txn_...          -> the PDF
import { getStore } from '@netlify/blobs';

const FILENAME = 'Frugal-Jewish-Kitchen-Harold-Rosenberg-2026.pdf';
const HELP = 'Please email hello@haroldcooks.com with your Paddle receipt and we will send your cookbook.';

const json = (body, status = 200) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export default async req => {
  const url = new URL(req.url);
  const txn = url.searchParams.get('txn') || '';
  const checkOnly = url.searchParams.has('check');

  if (!/^txn_[a-z0-9]{20,40}$/.test(txn)) {
    return checkOnly ? json({ ready: false, error: 'invalid' }, 400) : new Response(`This download link is not valid. ${HELP}`, { status: 400 });
  }

  // Strong consistency: the webhook may have written this order a second ago.
  const order = await getStore({ name: 'orders', consistency: 'strong' }).get(txn);
  if (!order) {
    return checkOnly ? json({ ready: false }) : new Response(`We could not find a completed payment for this order yet. ${HELP}`, { status: 404 });
  }
  if (checkOnly) return json({ ready: true });

  const pdf = await getStore('files').get('cookbook.pdf', { type: 'arrayBuffer' });
  if (!pdf) return new Response(`The cookbook file is temporarily unavailable. ${HELP}`, { status: 500 });

  return new Response(pdf, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${FILENAME}"`,
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex',
    },
  });
};

export const config = { path: '/api/download' };
