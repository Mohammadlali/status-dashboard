/**
 * Vercel Serverless Function: GET /api/status
 *
 * Serves the fleet status feed straight from the fleet's status Gist
 * (file: status.json) instead of a static file baked into the deployment.
 * This is the fix for the free-tier Vercel "api-deployments-free-per-day"
 * cap (100/day): the old pipeline ran `vercel deploy` every 5 minutes just
 * to publish a fresh status.json (288 deploys/day, ~3x the cap), so
 * refreshes silently stopped landing partway through most days.
 * refresh-status-data.yml now writes straight to the gist on the same
 * 5-minute cron with NO deploy involved -- invoking this function to read
 * it back doesn't count against the deployment cap at all, only against
 * Vercel's much higher (effectively unlimited for this traffic)
 * function-invocation limits. Actual code deploys now only happen when
 * the site's own files change.
 *
 * Originally built against Cloudflare R2 -- abandoned 2026-09-12 after
 * live-testing 4 different client/runtime combinations (aws-sdk-v3
 * default, pinned SDK + disabled flexible checksums, presigned URL +
 * native fetch(), pinned Node 18 runtime) and hitting the identical TLS
 * handshake failure every time. Root cause turned out to be account-level,
 * not code: R2 was never fully provisioned on the owner's Cloudflare
 * account (billing), so Cloudflare blocks all TLS to the R2 endpoint
 * account-wide. A Gist's raw file URL needs no token to read (secret
 * gists are unlisted, not access-controlled), so this function is now a
 * plain fetch(), nothing S3-shaped left at all.
 */

const STATUS_GIST_ID = '8a1dbd864c788597da9c7750c70bd419';
const STATUS_GIST_OWNER = 'Mohammadlali';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed. Use GET.' });
    return;
  }

  try {
    const url = `https://gist.githubusercontent.com/${STATUS_GIST_OWNER}/${STATUS_GIST_ID}/raw/status.json?t=${Date.now()}`;
    const resp = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } });

    if (resp.status === 404) {
      res.status(404).json({ error: 'status.json not found in the gist yet -- has refresh-status-data.yml run at least once?' });
      return;
    }
    if (!resp.ok) {
      res.status(502).json({ error: 'Gist returned an error for status.json', status: resp.status });
      return;
    }

    const body = await resp.text();
    res.setHeader('Content-Type', 'application/json');
    res.status(200).send(body);
  } catch (err) {
    console.error('status error:', err, err.cause);
    res.status(502).json({
      error: 'Failed to read status.json from the gist',
      detail: err.message,
      cause: err.cause ? (err.cause.message || String(err.cause)) : null,
    });
  }
}
