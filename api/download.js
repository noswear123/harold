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
//    payment check above has passed. Vercel authenticates the read over OIDC
//    automatically once the store is connected to the project.
//
// Runs on the Node.js runtime, not the edge, for two reasons: @vercel/blob
// depends on undici, which needs node:stream and friends and fails an edge
// build outright; and this file uses Vercel's (req, res) Node handler.
//
// Environment:
//   PADDLE_API_KEY     server-side Paddle key, used to look the transaction up
//   BLOB_STORE_ID      added automatically when the Blob store is connected
//   VERCEL_OIDC_TOKEN  added and rotated automatically by Vercel
import { Readable } from 'node:stream';
import { get } from '@vercel/blob';

const PRICE_ID = 'pri_01m3cnmvbdeb542pmtxvrdm919';
const PDF_PATHNAME = process.env.PDF_PATHNAME || 'cookbook.pdf';
const FILENAME = 'Frugal-Jewish-Kitchen-Harold-Rosenberg-2026.pdf';
const HELP = 'Please email hello@haroldcooks.com with your Paddle receipt and we will send your cookbook.';

// Returns { paid } on success, or { error } when Paddle itself could not be
// asked. Those two cases look identical to a buyer but mean very different
// things to us: "not paid" is a real answer, "paddle_403" is a broken API key.
async function checkPaddle(txn, apiKey) {
  const r = await fetch(`https://api.paddle.com/transactions/${txn}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!r.ok) {
    // Surface Paddle's own error code. "authentication_malformed" means the
    // value in PADDLE_API_KEY is not a key at all; "invalid_token" or similar
    // means it is a key, but revoked or from a different seller account.
    // Only the code is exposed, never the key.
    let code = '';
    try { code = (await r.json())?.error?.code || ''; } catch {}
    // Shape only — enough to tell a real key from a checkout token, never the value.
    const shape = `${apiKey.slice(0, 16)}…len${apiKey.length}`;
    return { error: `paddle_${r.status}${code ? '_' + code : ''}`, shape };
  }
  const { data } = await r.json();
  if (!data) return { error: 'paddle_no_data' };
  const paid = data.status === 'completed'
    && (data.items || []).some(i => i.price?.id === PRICE_ID);
  return { paid };
}

export default async function handler(req, res) {
  const txn = (req.query?.txn || '').toString();
  const checkOnly = req.query?.check !== undefined;

  const fail = (status, ready, error, text) => {
    res.setHeader('Cache-Control', 'no-store');
    return checkOnly
      ? res.status(status).json(error ? { ready, error } : { ready })
      : res.status(status).send(text);
  };

  if (!/^txn_[a-z0-9]{20,40}$/.test(txn)) {
    return fail(400, false, 'invalid', `This download link is not valid. ${HELP}`);
  }

  // Tolerate the two things that routinely survive a copy-paste into a hosting
  // dashboard: surrounding whitespace or a newline, and a "Bearer " prefix.
  // Either one makes Paddle reject the header as authentication_malformed.
  const apiKey = (process.env.PADDLE_API_KEY || '').trim().replace(/^Bearer\s+/i, '');
  if (!apiKey) {
    return fail(500, false, 'not_configured', `The download is temporarily unavailable. ${HELP}`);
  }

  try {
    const { paid, error, shape } = await checkPaddle(txn, apiKey);
    if (error) {
      console.error('paddle lookup failed', txn, error, shape);
      return fail(502, false, `${error} key=${shape}`, `The download is temporarily unavailable. ${HELP}`);
    }
    if (!paid) {
      return fail(404, false, null, `We could not find a completed payment for this order yet. ${HELP}`);
    }
    if (checkOnly) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ready: true });
    }

    // Paid and verified — now, and only now, read the private blob.
    const result = await get(PDF_PATHNAME, { access: 'private' });
    if (result?.statusCode !== 200) {
      return res.status(500).send(`The cookbook file is temporarily unavailable. ${HELP}`);
    }

    res.setHeader('Content-Type', result.blob?.contentType || 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${FILENAME}"`);
    res.setHeader('Cache-Control', 'private, no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Robots-Tag', 'noindex');
    return Readable.fromWeb(result.stream).pipe(res);
  } catch (err) {
    // Never let an exception surface as Vercel's raw crash page: a buyer who has
    // actually paid should always get a sentence telling them what to do next.
    console.error('download failed', txn, err);
    return fail(500, false, 'error', `The download is temporarily unavailable. ${HELP}`);
  }
}
