/**
 * Vercel Serverless Function: POST /api/agy_create
 *
 * The ONLY way to reach the @agy bot is a real GitHub issue or a comment
 * on one -- control-agy.yml triggers on `issues: [opened]` and
 * `issue_comment: [created]` bodies starting with "@agy", nothing else.
 * There is no lightweight direct-LLM shortcut (deliberately -- the owner
 * wants every reply attributed to the same @agy bot, not a bare Claude
 * call), so this one endpoint serves both chat modes the frontend offers:
 *
 * - Plain message, no trailing "@agy": a quick company question. First
 *   message of a session -> opens an issue labelled `mode:quick_chat`
 *   (control-agy.yml reads that label and tells AGY to just answer from
 *   Team/START_HERE.md + Team/COMPANY_SCOPE.md, no repo changes).
 *   Follow-up messages -> pass the `issue_number` the first call
 *   returned, and this posts an `@agy `-prefixed COMMENT on that same
 *   issue instead of opening a new one, continuing the same thread.
 * - Message ending in "@agy" (case-insensitive, whitespace-tolerant): the
 *   marker is NOT stripped (kept verbatim so the Manager Workflow can read
 *   it, and so agy-issue-bot.yml's own trailing-marker trigger still
 *   matches once the issue lands) -- this is a real task, and
 *   Tools/route_topic.py + control-agy.yml's full STEP 0-5 pipeline
 *   (code, gates, commit) runs on it, same as opening the issue by hand
 *   on GitHub would.
 *
 * This page is only reachable by the owner (Vercel Deployment Protection
 * / SSO stays on deliberately -- see Team/CHANGELOG.md, commit a1792b4 in
 * Control-Room -- specifically because this endpoint can trigger real
 * work against the owner's own repos).
 */

const PROJECT_LABELS = {
  control_room: 'project:control-room',
  tbs: 'project:tbs',
  airboxvip: 'project:airboxvip',
  status_dashboard: 'project:status_dashboard',
};

const TRAILING_ISSUE_MARKER_RE = /\s*@agy\s*$/i;
const REPO = 'mohammadlali0707-stack/agw-workers';

async function createIssue({ pat, title, body, labels }) {
  const resp = await fetch(`https://api.github.com/repos/${REPO}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title, body, labels }),
  });
  return resp;
}

async function commentOnIssue({ pat, issueNumber, body }) {
  const resp = await fetch(
    `https://api.github.com/repos/${REPO}/issues/${issueNumber}/comments`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body }),
    }
  );
  return resp;
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
    let message = ((body && body.message) || '').trim();
    const project = ((body && body.project) || '').trim();
    const existingIssueNumber = parseInt((body && body.issue_number) || '', 10) || null;

    if (!message) {
      res.status(400).json({ error: 'message is required' });
      return;
    }
    if (message.length > 4000) {
      res.status(400).json({ error: 'message too long (max 4000 characters)' });
      return;
    }

    const pat = process.env.AGY_CHAT_ACC6_PAT;
    if (!pat) {
      res.status(500).json({ error: 'AGY_CHAT_ACC6_PAT is not configured on Vercel' });
      return;
    }

    const isTask = TRAILING_ISSUE_MARKER_RE.test(message);
    // We do NOT strip the marker here anymore, so the Manager Workflow can read it.

    // The user will manually append @agy at the end. We send the message exactly as typed.
    const agyBody = message;

    // Follow-up quick-chat turn: comment on the existing thread instead of
    // opening a new issue. Only valid when NOT a task -- "@agy" always
    // starts a fresh, dedicated issue regardless of any session in progress.
    if (!isTask && existingIssueNumber) {
      const ghResp = await commentOnIssue({ pat, issueNumber: existingIssueNumber, body: agyBody });
      if (!ghResp.ok) {
        console.error('agy_create: comment failed, status', ghResp.status);
        res.status(502).json({ error: 'Failed to comment on GitHub issue', status: ghResp.status });
        return;
      }
      const comment = await ghResp.json();
      res.status(200).json({
        status: 'commented',
        mode: 'quick_chat',
        issue_number: existingIssueNumber,
        comment_url: comment.html_url,
      });
      return;
    }

    const labels = [];
    if (Object.prototype.hasOwnProperty.call(PROJECT_LABELS, project)) {
      labels.push(PROJECT_LABELS[project]);
    }
    if (!isTask) {
      labels.push('mode:quick_chat');
    }

    // Titles can't contain newlines; collapse whitespace and keep it short.
    const title = message.replace(/\s+/g, ' ').trim().slice(0, 80) || 'AGY chat request';

    const ghResp = await createIssue({ pat, title, body: agyBody, labels });
    if (!ghResp.ok) {
      console.error('agy_create: GitHub issue creation failed, status', ghResp.status);
      res.status(502).json({ error: 'Failed to create issue on GitHub', status: ghResp.status });
      return;
    }

    const issue = await ghResp.json();
    res.status(200).json({
      status: 'created',
      mode: isTask ? 'task' : 'quick_chat',
      issue_number: issue.number,
      issue_url: issue.html_url,
    });
  } catch (err) {
    console.error('agy_create error:', err.message);
    res.status(500).json({ error: 'internal error' });
  }
}
