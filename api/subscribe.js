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

    // Dynamic import of S3 client if available
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
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

    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: 'subscriptions/subscription.json',
      Body: JSON.stringify(subscription, null, 2),
      ContentType: 'application/json'
    });

    await s3.send(command);

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
