// Stand-in for the Blocks REST API, used by the CI end-to-end job.
//
// It deliberately reproduces the two behaviours that are easy to get wrong and
// impossible to see in unit tests:
//   1. `_links` hrefs point at a *different* host than the one the client is
//      talking to (the real API builds them from its own env), so the action
//      has to rebase them onto `api_base_url`.
//   2. The final message is not there on the first poll, and one poll is
//      answered with a 429, so the poll loop and the retry path both run.
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 3999);
const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const THREAD_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
// A follow-up message opens its own thread, just like the real API.
const FOLLOW_UP_THREAD_ID = 'cccccccc-dddd-4eee-8fff-000000000000';
const FINAL_MESSAGE = 'Reviewed the PR and left 3 comments.';
const PR_URL = 'https://github.com/BlocksOrg/blocks-ci-sessions/pull/1';
// The href host the action must rebase away from.
const FOREIGN_BASE = 'https://api.prod.blocks.team';
// Raise this to keep the agent 'working' and exercise the timeout path.
const POLLS_BEFORE_DONE = Number(process.env.MOCK_POLLS_BEFORE_DONE ?? 2);

let polls = 0;
let rateLimitedOnce = false;

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

function session(threadId) {
  const thread = `${FOREIGN_BASE}/rest/v1/sessions/${SESSION_ID}/threads/${threadId}/messages`;
  return {
    id: SESSION_ID,
    title: 'PR review',
    pull_requests: polls > POLLS_BEFORE_DONE ? [PR_URL] : [],
    source_url: null,
    is_archived: false,
    is_private: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    thread_id: threadId,
    session_group_id: null,
    session_html_url: `https://blocks.team/app/w1/sessions/${SESSION_ID}`,
    _links: {
      self: { href: `${FOREIGN_BASE}/rest/v1/sessions/${SESSION_ID}` },
      messages: { href: `${FOREIGN_BASE}/rest/v1/sessions/${SESSION_ID}/messages` },
      thread: { href: thread },
      final_message: { href: `${thread}?type=final_message&role=assistant` },
    },
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.headers.authorization !== `ApiKey ${process.env.MOCK_API_KEY ?? 'test-key'}`) {
    return json(res, 401, { error: 'Unauthorized' });
  }

  if (req.method === 'POST' && url.pathname === '/rest/v1/sessions') {
    const body = JSON.parse(await readBody(req));
    if (!body.agent_name && !body.agent_id && !body.profile) {
      return json(res, 422, {
        error: 'Either agent_id, agent_name, or profile must be provided.',
      });
    }
    return json(res, 200, session(THREAD_ID));
  }

  if (req.method === 'POST' && url.pathname === `/rest/v1/sessions/${SESSION_ID}/messages`) {
    const thread = `${FOREIGN_BASE}/rest/v1/sessions/${SESSION_ID}/threads/${FOLLOW_UP_THREAD_ID}/messages`;
    return json(res, 200, {
      id: 'm0',
      chat_id: SESSION_ID,
      chat_thread_id: FOLLOW_UP_THREAD_ID,
      task_id: 'task-1',
      role: 'user',
      type: 'message',
      message: JSON.parse(await readBody(req)).message,
      ts: Date.now() / 1000,
      _links: {
        self: { href: `${FOREIGN_BASE}/rest/v1/sessions/${SESSION_ID}/messages` },
        thread: { href: thread },
        final_message: { href: `${thread}?type=final_message&role=assistant` },
      },
    });
  }

  if (req.method === 'GET' && url.pathname === `/rest/v1/sessions/${SESSION_ID}`) {
    return json(res, 200, { ...session(null), thread_id: null });
  }

  if (req.method === 'GET' && url.pathname.endsWith('/messages')) {
    if (!rateLimitedOnce) {
      rateLimitedOnce = true;
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
      return res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
    }
    polls += 1;
    const done = polls > POLLS_BEFORE_DONE;
    return json(res, 200, {
      items: done
        ? [
            {
              id: 'm1',
              chat_thread_id: THREAD_ID,
              role: 'assistant',
              type: 'final_message',
              message: FINAL_MESSAGE,
              ts: Date.now() / 1000,
            },
          ]
        : [],
      meta: { total: done ? 1 : 0, page: 1, limit: 50, total_pages: done ? 1 : 0 },
      _links: { self: { href: url.href }, new_messages: { href: url.href } },
    });
  }

  return json(res, 404, { error: `No mock route for ${req.method} ${url.pathname}` });
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data || '{}'));
    req.on('error', reject);
  });
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock blocks api listening on http://127.0.0.1:${PORT}`);
});
