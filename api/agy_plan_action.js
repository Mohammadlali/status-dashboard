/**
 * Vercel Serverless Function: POST /api/agy_plan_action
 *
 * Backend for the proposal Accept/Decline card the dashboard renders when
 * a chat reply carries a tbs_task_proposal (see agy-plan-bot.yml on
 * agw-workers, and the card-rendering code in app.js). This endpoint never
 * dispatches anything itself -- it only posts a comment on the SAME
 * agw-workers issue the proposal came from, and the two GitHub-side
 * workflows do the rest:
 *
 * - action "accept": posts a comment ending in "@agy-plan-approved".
 *   agy-plan-dispatch.yml (agw-workers) picks that up, parses the latest
 *   proposal from the issue's own comment history, and does the actual
 *   staggered batch dispatch.
 * - action "decline": posts the reviewer's revision note, ending in
 *   "@agy-plan", as a new comment on the same issue. agy-plan-bot.yml
 *   fires again on that comment, reads the FULL thread (including its own
 *   earlier proposal), and posts a revised one -- same issue, same loop.
 */

const REPO = 'mohammadlali0707-stack/agw-workers';

async function commentOnIssue({ pat, issueNumber, body }) {
  return fetch(`https://api.github.com/repos/${REPO}/issues/${issueNumber}/comments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ body }),
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const issueNumber = parseInt((body && body.issue_number) || '', 10);
    const action = (body && body.action) || '';
    const note = ((body && body.note) || '').trim();

    if (!issueNumber || issueNumber <= 0) {
      res.status(400).json({ error: 'issue_number is required' });
      return;
    }
    if (action !== 'accept' && action !== 'decline') {
      res.status(400).json({ error: 'action must be "accept" or "decline"' });
      return;
    }
    if (action === 'decline' && !note) {
      res.status(400).json({ error: 'note is required for a decline (explain what to change)' });
      return;
    }
    if (note.length > 4000) {
      res.status(400).json({ error: 'note too long (max 4000 characters)' });
      return;
    }

    const pat = process.env.AGY_CHAT_ACC6_PAT;
    if (!pat) {
      res.status(500).json({ error: 'AGY_CHAT_ACC6_PAT is not configured on Vercel' });
      return;
    }

    const commentBody = action === 'accept'
      ? 'تایید شد. @agy-plan-approved'
      : `${note}\n\n@agy-plan`;

    const ghResp = await commentOnIssue({ pat, issueNumber, body: commentBody });
    if (!ghResp.ok) {
      console.error('agy_plan_action: comment failed, status', ghResp.status);
      res.status(502).json({ error: 'Failed to comment on GitHub issue', status: ghResp.status });
      return;
    }
    const comment = await ghResp.json();
    res.status(200).json({ status: 'ok', action, issue_number: issueNumber, comment_url: comment.html_url });
  } catch (err) {
    console.error('agy_plan_action error:', err.message);
    res.status(500).json({ error: 'internal error' });
  }
}
