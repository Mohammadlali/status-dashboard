/**
 * Vercel Serverless Function: /api/subscribe
 * Receives Web Push subscription from client and stores it in Cloudflare R2
 * if R2 environment variables are configured.
 */

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

    const endpoint = process.env.R2_S3_ENDPOINT;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    const bucket = process.env.R2_BUCKET || 'claud-cloud-status';

    if (!endpoint || !accessKeyId || !secretAccessKey) {
      // Return 200 with notice if R2 credentials are only configured in GitHub Actions
      console.warn('R2 credentials not set on Vercel; subscription acknowledged.');
      res.status(200).json({
        status: 'acknowledged',
        note: 'R2 credentials not configured on Vercel environment. Use direct R2 presigned upload if available.',
        received: { endpoint: subscription.endpoint.substring(0, 45) + '...' }
      });
      return;
    }

    // Dynamic import of S3 client if available. The actual write goes through
    // a presigned URL + native fetch(), not s3.send() directly -- S3Client's
    // own bundled HTTP handler consistently fails the TLS handshake talking
    // to R2 from inside a Vercel function (see api/status.js for the same
    // fix and the live-test evidence); getSignedUrl() does no network I/O
    // itself, it only computes the SigV4 signature.
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const s3 = new S3Client({
      region: 'auto',
      endpoint: endpoint,
      forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      credentials: {
        accessKeyId: accessKeyId,
        secretAccessKey: secretAccessKey
      }
    });

    const body = JSON.stringify(subscription, null, 2);
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: 'subscriptions/subscription.json',
      ContentType: 'application/json'
    });
    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 60 });
    const putResp = await fetch(signedUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body
    });
    if (!putResp.ok) {
      throw new Error(`R2 PUT failed with status ${putResp.status}`);
    }

    res.status(200).json({
      status: 'success',
      message: 'Subscription stored in Cloudflare R2 successfully.',
      endpoint: subscription.endpoint.substring(0, 45) + '...'
    });
  } catch (err) {
    console.error('Subscription error:', err);
    res.status(500).json({ error: err.message });
  }
}
