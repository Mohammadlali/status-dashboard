/**
 * Vercel Serverless Function: GET /api/agy_status?issue_number=N
 *
 * Polls the Control-Room issue's comments for the chat transcript. If
 * control-agy.yml's "Forward to another project's repo" step ran (topic
 * was tbs/airboxvip, not control-room/status_dashboard), it leaves a
 * "Forwarded: <issue url>" comment -- follow it and read the REAL
 * conversation from mohammadlali0707-stack/agw-workers.
 * The frontend fetches this to render the ongoing conversation.
 *
 * NOTE: This is strictly for the quick-chat mode. A task / @agy
 * forwarded topic (agw-workers's copy gets no further comments after
 * the forward).
 */

// Repo-specific read tokens for projects that live outside ACC0. Each
// should be a narrowly-scoped fine-grained PAT (Issues: read is enough)
// for exactly that one repo -- not the broader Actions-dispatch PATs
// used elsewhere in this fleet.
const REPO_PATS = {
  'mohammadlali0707-stack/Claud-Cloud-Project': () => process.env.AGY_CHAT_ACC6_PAT,
  'momonakikugava-pixel/AirboxVIP_Coffeenet': () => process.env.AGY_CHAT_ACC1_PAT,
};

const FORWARD_RE = /^Forwarded:\s*(https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+))/m;

async function fetchComments(ownerRepo, issueNumber, pat) {
  const resp = await fetch(
    `https://api.github.com/repos/${ownerRepo}/issues/${issueNumber}/comments?per_page=50`,
    {
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }
  );
  if (!resp.ok) return null;
  return resp.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed. Use GET.' });
    return;
  }

  try {
    const issueNumber = parseInt((req.query && req.query.issue_number) || '', 10);
    if (!issueNumber || issueNumber <= 0) {
      res.status(400).json({ error: 'issue_number is required' });
      return;
    }

    const acc0Pat = process.env.AGY_CHAT_ACC0_PAT;
    if (!acc0Pat) {
      res.status(500).json({ error: 'AGY_CHAT_ACC0_PAT is not configured on Vercel' });
      return;
    }

    const comments = await fetchComments('mohammadlali0707-stack/agw-workers', issueNumber, acc0Pat);
    if (!comments) {
      res.status(502).json({ error: 'Failed to read agw-workers issue comments' });
      return;
    }

    let sourceRepo = 'mohammadlali0707-stack/agw-workers';
    let sourceIssue = issueNumber;
    let finalComments = comments;
    let forwarded = false;

    for (const c of comments) {
      const m = FORWARD_RE.exec(c.body || '');
      if (!m) continue;
      const targetRepo = m[2];
      const targetIssue = parseInt(m[3], 10);
      const patGetter = REPO_PATS[targetRepo];
      const targetPat = patGetter ? patGetter() : null;
      if (!targetPat) break; // no read credential for that repo; show what we have
      const targetComments = await fetchComments(targetRepo, targetIssue, targetPat);
      if (targetComments === null) break;
      sourceRepo = targetRepo;
      sourceIssue = targetIssue;
      finalComments = targetComments;
      forwarded = true;
      break;
    }

    const replies = finalComments.map((c) => ({
      author: (c.user && c.user.login) || 'unknown',
      body: c.body,
      created_at: c.created_at,
      html_url: c.html_url,
    }));

    res.status(200).json({
      status: 'ok',
      forwarded,
      source_repo: sourceRepo,
      source_issue: sourceIssue,
      replies,
    });
  } catch (err) {
    console.error('agy_status error:', err.message);
    res.status(500).json({ error: 'internal error' });
  }
}
