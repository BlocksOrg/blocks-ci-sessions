import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionInputs } from '../inputs';
import type { BlocksClient } from '../client';

vi.mock('@actions/core', () => ({
  info: vi.fn(),
  warning: vi.fn(),
  debug: vi.fn(),
  setFailed: vi.fn(),
  setOutput: vi.fn(),
  setSecret: vi.fn(),
  getInput: vi.fn(() => ''),
  summary: {},
}));

const { run } = await import('../index');

const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const FINAL_HREF = `https://api.blocks.team/rest/v1/sessions/${SESSION_ID}/threads/t1/messages?type=final_message&role=assistant`;
const HTML_URL = `https://blocks.team/app/w1/sessions/${SESSION_ID}`;

function inputs(overrides: Partial<ActionInputs> = {}): ActionInputs {
  return {
    apiKey: 'key',
    apiBaseUrl: 'https://api.blocks.team',
    prompt: 'review this pr',
    isPrivate: false,
    timeoutMs: 60_000,
    pollIntervalMs: 5_000,
    failOnTimeout: true,
    ...overrides,
  };
}

function sessionPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    title: 'Review',
    pull_requests: [],
    thread_id: 't1',
    session_html_url: HTML_URL,
    _links: {
      self: { href: '' },
      messages: { href: '' },
      thread: { href: '' },
      final_message: { href: FINAL_HREF },
    },
    ...overrides,
  };
}

/** Minimal stand-in for BlocksClient — only the methods `run` touches. */
function stubClient(overrides: Record<string, unknown> = {}) {
  return {
    createSession: vi.fn(async () => sessionPayload()),
    postMessage: vi.fn(async () => ({
      chat_thread_id: 't2',
      _links: { self: { href: '' }, thread: { href: '' }, final_message: { href: FINAL_HREF } },
    })),
    getSession: vi.fn(async () =>
      sessionPayload({ pull_requests: ['https://github.com/o/r/pull/1'] }),
    ),
    fetchFinalMessage: vi.fn(async () => 'all done'),
    ...overrides,
  } as unknown as BlocksClient;
}

/** Clock that only advances when `run` awaits its sleep. */
function fakeClock() {
  let current = 0;
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('run — creating a session', () => {
  it('sends agent_name only when an agent was supplied', async () => {
    const client = stubClient();
    await run(inputs({ agent: 'claude' }), client, () => {}, fakeClock());
    expect(client.createSession).toHaveBeenCalledWith({
      message: 'review this pr',
      agent_name: 'claude',
    });
  });

  it('sends agent_id instead of agent_name when a custom agent was supplied', async () => {
    const client = stubClient();
    await run(
      inputs({ agentId: '99999999-8888-4777-8666-555555555555' }),
      client,
      () => {},
      fakeClock(),
    );
    const body = vi.mocked(client.createSession).mock.calls[0][0];
    expect(body).toHaveProperty('agent_id', '99999999-8888-4777-8666-555555555555');
    expect(body).not.toHaveProperty('agent_name');
  });

  it('forwards the optional creation fields', async () => {
    const client = stubClient();
    await run(
      inputs({
        agentId: '99999999-8888-4777-8666-555555555555',
        title: 'PR review',
        sessionGroupId: '11111111-2222-4333-8444-555555555555',
        isPrivate: true,
      }),
      client,
      () => {},
      fakeClock(),
    );
    expect(client.createSession).toHaveBeenCalledWith({
      message: 'review this pr',
      agent_id: '99999999-8888-4777-8666-555555555555',
      title: 'PR review',
      session_group_id: '11111111-2222-4333-8444-555555555555',
      is_private: true,
    });
  });

  it('announces the session id before it starts polling', async () => {
    const order: string[] = [];
    const client = stubClient({
      fetchFinalMessage: vi.fn(async () => {
        order.push('poll');
        return 'all done';
      }),
    });

    await run(
      inputs(),
      client,
      (partial) => {
        order.push(`announced:${partial.session_id}`);
      },
      fakeClock(),
    );

    expect(order[0]).toBe(`announced:${SESSION_ID}`);
    expect(order).toContain('poll');
  });

  it('returns the final message and refreshed pull requests', async () => {
    const result = await run(inputs(), stubClient(), () => {}, fakeClock());
    expect(result).toEqual({
      session_id: SESSION_ID,
      thread_id: 't1',
      session_html_url: HTML_URL,
      final_message: 'all done',
      pull_requests: ['https://github.com/o/r/pull/1'],
      status: 'completed',
    });
  });

  it('still completes when the pull_requests refresh fails', async () => {
    const client = stubClient({
      getSession: vi.fn(async () => {
        throw new Error('502');
      }),
    });
    const result = await run(inputs(), client, () => {}, fakeClock());
    expect(result.status).toBe('completed');
    expect(result.pull_requests).toEqual([]);
  });

  it('fails loudly when the API returns no final_message link', async () => {
    const client = stubClient({
      createSession: vi.fn(async () =>
        sessionPayload({
          thread_id: null,
          _links: {
            self: { href: '' },
            messages: { href: '' },
            thread: null,
            final_message: null,
          },
        }),
      ),
    });
    await expect(run(inputs(), client, () => {}, fakeClock())).rejects.toThrow(
      /without a final_message link/,
    );
  });
});

describe('run — polling', () => {
  it('keeps polling until the final message lands', async () => {
    const fetchFinalMessage = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('all done');
    const client = stubClient({ fetchFinalMessage });

    const result = await run(inputs(), client, () => {}, fakeClock());

    expect(fetchFinalMessage).toHaveBeenCalledTimes(3);
    expect(result.final_message).toBe('all done');
  });

  it('gives up at the deadline and reports timed_out', async () => {
    const client = stubClient({ fetchFinalMessage: vi.fn(async () => null) });

    const result = await run(
      inputs({ timeoutMs: 20_000, pollIntervalMs: 5_000 }),
      client,
      () => {},
      fakeClock(),
    );

    expect(result.status).toBe('timed_out');
    expect(result.final_message).toBe('');
    expect(result.session_id).toBe(SESSION_ID);
  });

  it('announces the session id even when it goes on to time out', async () => {
    const announced: string[] = [];
    const client = stubClient({ fetchFinalMessage: vi.fn(async () => null) });

    await run(
      inputs({ timeoutMs: 10_000 }),
      client,
      (partial) => announced.push(partial.session_id),
      fakeClock(),
    );

    expect(announced).toEqual([SESSION_ID]);
  });

  it('never sleeps past the deadline', async () => {
    const sleeps: number[] = [];
    const client = stubClient({ fetchFinalMessage: vi.fn(async () => null) });
    let current = 0;

    await run(inputs({ timeoutMs: 7_000, pollIntervalMs: 5_000 }), client, () => {}, {
      now: () => current,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        current += ms;
      },
    });

    expect(sleeps).toEqual([5_000, 2_000]);
  });
});

describe('run — resuming a session', () => {
  it('posts a follow-up instead of creating a session', async () => {
    const client = stubClient();
    const result = await run(inputs({ sessionId: SESSION_ID }), client, () => {}, fakeClock());

    expect(client.createSession).not.toHaveBeenCalled();
    expect(client.postMessage).toHaveBeenCalledWith(SESSION_ID, 'review this pr');
    expect(result.session_id).toBe(SESSION_ID);
    // The follow-up gets its own thread, and that is what we poll.
    expect(result.thread_id).toBe('t2');
    expect(result.status).toBe('completed');
  });

  it('ignores agent inputs on the resume path', async () => {
    const client = stubClient();
    await run(inputs({ sessionId: SESSION_ID, agent: 'codex' }), client, () => {}, fakeClock());
    expect(client.createSession).not.toHaveBeenCalled();
  });
});

describe('formatDuration', () => {
  it('reports sub-minute budgets in seconds rather than rounding to "0 minutes"', async () => {
    const { formatDuration } = await import('../index');
    expect(formatDuration(6_000)).toBe('6s');
    expect(formatDuration(59_000)).toBe('59s');
  });

  it('reports whole and fractional minutes', async () => {
    const { formatDuration } = await import('../index');
    expect(formatDuration(30 * 60_000)).toBe('30 minute(s)');
    expect(formatDuration(90_000)).toBe('1.5 minute(s)');
  });
});
