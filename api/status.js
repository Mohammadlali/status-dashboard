/**
 * Vercel Serverless Function: GET /api/status
 *
 * Serves the fleet status feed straight from Cloudflare R2 (bucket
 * claud-cloud-status, key "status.json") instead of a static file baked
 * into the deployment. This is the fix for the free-tier Vercel
 * "api-deployments-free-per-day" cap (100/day): the old pipeline ran
 * `vercel deploy` every 5 minutes just to publish a fresh status.json
 * (288 deploys/day, ~3x the cap), so refreshes silently stopped landing
 * partway through most days. refresh-status-data.yml now writes straight
 * to R2 on the same 5-minute cron with NO deploy involved -- invoking
 * this function to read that object back doesn't count against the
 * deployment cap at all, only against Vercel's much higher (effectively
 * unlimited for this traffic) function-invocation limits. Actual code
 * deploys now only happen when the site's own files change.
 */

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
    const endpoint = process.env.R2_S3_ENDPOINT;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    const bucket = process.env.R2_BUCKET || 'claud-cloud-status';

    if (!endpoint || !accessKeyId || !secretAccessKey) {
      res.status(500).json({ error: 'R2 credentials are not configured on Vercel.' });
      return;
    }

    const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
    const s3 = new S3Client({
      region: 'auto',
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    });

    const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: 'status.json' }));
    const body = await result.Body.transformToString();

    res.setHeader('Content-Type', 'application/json');
    res.status(200).send(body);
  } catch (err) {
    if (err.name === 'NoSuchKey') {
      res.status(404).json({ error: 'status.json not found in R2 yet -- has refresh-status-data.yml run at least once?' });
      return;
    }
    console.error('status error:', err);
    res.status(502).json({ error: 'Failed to read status.json from R2', detail: err.message });
  }
}
