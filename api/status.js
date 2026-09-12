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
 *
 * The actual object fetch goes through a presigned URL + native fetch(),
 * not S3Client.send() directly: live-tested against the real R2 endpoint
 * from inside a Vercel function, S3Client's own bundled HTTP handler
 * (Node's https module under the SDK's connection pooling) consistently
 * failed the TLS handshake (SSL alert 40) talking to R2, while the same
 * credentials work fine from a plain GitHub Actions runner (boto3) and a
 * plain fetch() call. getSignedUrl() does no network I/O itself -- it
 * only computes the SigV4 signature -- so S3Client is used purely as a
 * signer here; the real GET rides Vercel's native fetch implementation.
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
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const s3 = new S3Client({
      region: 'auto',
      endpoint,
      forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      credentials: { accessKeyId, secretAccessKey },
    });

    const command = new GetObjectCommand({ Bucket: bucket, Key: 'status.json' });
    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 60 });

    const r2Resp = await fetch(signedUrl);
    if (r2Resp.status === 404) {
      res.status(404).json({ error: 'status.json not found in R2 yet -- has refresh-status-data.yml run at least once?' });
      return;
    }
    if (!r2Resp.ok) {
      res.status(502).json({ error: 'R2 returned an error for status.json', status: r2Resp.status });
      return;
    }
    const body = await r2Resp.text();

    res.setHeader('Content-Type', 'application/json');
    res.status(200).send(body);
  } catch (err) {
    console.error('status error:', err);
    res.status(502).json({ error: 'Failed to read status.json from R2', detail: err.message });
  }
}
