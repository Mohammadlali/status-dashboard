/**
 * Vercel Serverless Function: /api/subscribe
 * Receives a Web Push subscription from the client and stores it in the
 * fleet's status Gist (file: subscription.json).
 *
 * Moved off Cloudflare R2 2026-09-12: R2 is permanently unavailable on the
 * owner's Cloudflare account (not fully provisioned, so Cloudflare blocks
 * all TLS to the R2 endpoint account-wide -- confirmed identically across
 * 4 separate client/runtime combinations while debugging api/status.js).
 * Unlike R2, a Gist write always needs an authenticated Bearer token --
 * there is no presigned-upload-URL equivalent -- so this endpoint now does
 * the write itself server-side using ACC0_PAT (needs the 'gist' scope;
 * same token name/value already used by Tools/collect_status_feed.py in
 * GitHub Actions, just also added as a Vercel environment variable here).
 */

const STATUS_GIST_ID = '8a1dbd864c788597da9c7750c70bd419';

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }

  try {
    const subscription = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

    if (!subscription || !subscription.endpoint) {
      res.status(400).json({ error: 'Invalid subscription object: missing endpoint.' });
      return;
    }

    const token = process.env.ACC0_PAT;
    if (!token) {
      console.warn('ACC0_PAT not set on Vercel; subscription acknowledged but not persisted.');
      res.status(200).json({
        status: 'acknowledged',
        note: 'ACC0_PAT is not configured on Vercel yet -- subscription received but not saved.',
        received: { endpoint: subscription.endpoint.substring(0, 45) + '...' }
      });
      return;
    }

    const ghResp = await fetch(`https://api.github.com/gists/${STATUS_GIST_ID}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        files: {
          'subscription.json': { content: JSON.stringify(subscription, null, 2) },
        },
      }),
    });

    if (!ghResp.ok) {
      const detail = await ghResp.text();
      throw new Error(`Gist PATCH failed with status ${ghResp.status}: ${detail.slice(0, 200)}`);
    }

    res.status(200).json({
      status: 'success',
      message: 'Subscription stored in the status gist successfully.',
      endpoint: subscription.endpoint.substring(0, 45) + '...'
    });
  } catch (err) {
    console.error('Subscription error:', err);
    res.status(500).json({ error: err.message });
  }
}
