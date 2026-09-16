import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getMock, postMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
}));

vi.mock('@actions/http-client', () => ({
  HttpClient: class {
    get = getMock;
    post = postMock;
  },
}));

const { BlocksApiError, BlocksClient, jitteredBackoff, retryAfterMs } = await import('../client');

/** Shapes a fake `HttpClientResponse`. */
function response(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    message: { statusCode: status, headers },
    readBody: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function makeClient(overrides: { sleep?: (ms: number) => Promise<void> } = {}) {
  return new BlocksClient({
    apiKey: 'secret',
    baseUrl: 'https://api.blocks.team',
    sleep: overrides.sleep ?? (async () => {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BlocksClient.createSession', () => {
  it('posts to the sessions endpoint with the ApiKey scheme', async () => {
    postMock.mockResolvedValue(response(200, { id: 'abc' }));

    const session = await makeClient().createSession({ message: 'hi', agent_name: 'claude' });

    expect(session).toEqual({ id: 'abc' });
    const [url, body, headers] = postMock.mock.calls[0];
    expect(url).toBe('https://api.blocks.team/rest/v1/sessions');
    expect(JSON.parse(body)).toEqual({ message: 'hi', agent_name: 'claude' });
    expect(headers.authorization).toBe('ApiKey secret');
  });

  it('fails immediately on a validation error instead of retrying', async () => {
    postMock.mockResolvedValue(response(422, { error: 'Either agent_id, agent_name, or profile must be provided.' }));

    await expect(makeClient().createSession({ message: 'hi' })).rejects.toThrow(
      /Either agent_id, agent_name, or profile must be provided\./,
    );
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces the status code on the thrown error', async () => {
    postMock.mockResolvedValue(response(401, { error: 'Unauthorized' }));

    await expect(makeClient().createSession({ message: 'hi' })).rejects.toMatchObject({
      status: 401,
    });
  });
});

describe('BlocksClient retries', () => {
  it('retries a 429 and honours Retry-After', async () => {
    const sleep = vi.fn(async () => {});
    getMock
      .mockResolvedValueOnce(response(429, { error: 'slow down' }, { 'retry-after': '2' }))
      .mockResolvedValueOnce(response(200, { id: 'abc' }));

    await expect(makeClient({ sleep }).getSession('abc')).resolves.toEqual({ id: 'abc' });
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it('retries 5xx responses', async () => {
    getMock
      .mockResolvedValueOnce(response(503, 'upstream down'))
      .mockResolvedValueOnce(response(200, { id: 'abc' }));

    await expect(makeClient().getSession('abc')).resolves.toEqual({ id: 'abc' });
    expect(getMock).toHaveBeenCalledTimes(2);
  });

  it('retries transient network errors', async () => {
    getMock
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(response(200, { id: 'abc' }));

    await expect(makeClient().getSession('abc')).resolves.toEqual({ id: 'abc' });
  });

  it('gives up after five attempts', async () => {
    getMock.mockResolvedValue(response(500, 'boom'));

    await expect(makeClient().getSession('abc')).rejects.toBeInstanceOf(BlocksApiError);
    expect(getMock).toHaveBeenCalledTimes(5);
  });
});

describe('BlocksClient.resolveHref', () => {
  it('passes through a link that already matches the base url', () => {
    const href = 'https://api.blocks.team/rest/v1/sessions/a/threads/b/messages?type=final_message&role=assistant';
    expect(makeClient().resolveHref(href)).toBe(href);
  });

  it('rebases a link whose host differs from the configured base url', () => {
    const client = new BlocksClient({ apiKey: 'k', baseUrl: 'http://127.0.0.1:9123' });
    expect(
      client.resolveHref(
        'https://api.prod.blocks.team/rest/v1/sessions/a/threads/b/messages?type=final_message&role=assistant',
      ),
    ).toBe('http://127.0.0.1:9123/rest/v1/sessions/a/threads/b/messages?type=final_message&role=assistant');
  });

  it('keeps the server-chosen query string untouched', () => {
    const client = new BlocksClient({ apiKey: 'k', baseUrl: 'http://127.0.0.1:9123' });
    const resolved = new URL(
      client.resolveHref('https://api.prod.blocks.team/x?type=final_message&role=assistant'),
    );
    expect(resolved.searchParams.get('type')).toBe('final_message');
    expect(resolved.searchParams.get('role')).toBe('assistant');
  });
});

describe('BlocksClient.fetchFinalMessage', () => {
  const href = 'https://api.blocks.team/rest/v1/sessions/a/threads/b/messages?type=final_message&role=assistant';

  it('returns null while the agent is still working', async () => {
    getMock.mockResolvedValue(response(200, { items: [], meta: {} }));
    await expect(makeClient().fetchFinalMessage(href)).resolves.toBeNull();
  });

  it('returns the message text once it lands', async () => {
    getMock.mockResolvedValue(response(200, { items: [{ message: 'all done' }], meta: {} }));
    await expect(makeClient().fetchFinalMessage(href)).resolves.toBe('all done');
  });

  it('returns an empty string rather than null for an empty final message', async () => {
    getMock.mockResolvedValue(response(200, { items: [{ message: '' }], meta: {} }));
    await expect(makeClient().fetchFinalMessage(href)).resolves.toBe('');
  });
});

describe('retryAfterMs', () => {
  it('parses delta-seconds', () => {
    expect(retryAfterMs('3')).toBe(3_000);
  });

  it('parses an HTTP date', () => {
    const future = new Date(Date.now() + 4_000).toUTCString();
    expect(retryAfterMs(future)).toBeGreaterThan(2_000);
  });

  it('caps at the maximum backoff', () => {
    expect(retryAfterMs('9999')).toBe(30_000);
  });

  it('returns null when absent or unparseable', () => {
    expect(retryAfterMs(undefined)).toBeNull();
    expect(retryAfterMs('soon')).toBeNull();
  });
});

describe('jitteredBackoff', () => {
  it('grows exponentially and stays within the jitter window', () => {
    expect(jitteredBackoff(1, () => 0)).toBe(500);
    expect(jitteredBackoff(1, () => 1)).toBe(1_000);
    expect(jitteredBackoff(3, () => 1)).toBe(4_000);
  });

  it('never exceeds the cap', () => {
    expect(jitteredBackoff(20, () => 1)).toBe(30_000);
  });
});
