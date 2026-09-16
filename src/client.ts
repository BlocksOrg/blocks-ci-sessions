import { HttpClient } from '@actions/http-client';
import type {
  CreateSessionBody,
  MessageList,
  Session,
  SessionMessage,
} from './types';

/** Statuses the API uses for "your request is wrong" — retrying cannot help. */
const FATAL_STATUSES = new Set([400, 401, 403, 404, 405, 409, 422]);

const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

export class BlocksApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'BlocksApiError';
  }
}

export interface ClientOptions {
  apiKey: string;
  baseUrl: string;
  /** Overridable so tests do not have to sit through real backoff. */
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class BlocksClient {
  private readonly http: HttpClient;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (message: string) => void;

  constructor(options: ClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.sleep = options.sleep ?? defaultSleep;
    this.log = options.log ?? (() => {});
    // `HttpClient` picks up HTTPS_PROXY / NO_PROXY, which matters on
    // self-hosted runners behind a corporate proxy.
    this.http = new HttpClient('blocks-session-action');
  }

  /**
   * Rebases a server-supplied HATEOAS href onto the configured base URL.
   *
   * The API builds `_links` from its own environment-derived host, which does
   * not always match the host the caller reached it on (and never does when
   * `api_base_url` points at a mock or a preview environment). Path and query
   * are taken from the server verbatim — only the origin is swapped — so the
   * `?type=final_message&role=assistant` filter the API chose is preserved.
   */
  resolveHref(href: string): string {
    const target = new URL(href, `${this.baseUrl}/`);
    const base = new URL(this.baseUrl);
    if (target.origin === base.origin) return target.toString();
    this.log(`Rebasing API link ${target.origin} → ${base.origin}`);
    return `${this.baseUrl}${target.pathname}${target.search}`;
  }

  async createSession(body: CreateSessionBody): Promise<Session> {
    return this.request<Session>('POST', `${this.baseUrl}/rest/v1/sessions`, body);
  }

  async postMessage(sessionId: string, message: string): Promise<SessionMessage> {
    return this.request<SessionMessage>(
      'POST',
      `${this.baseUrl}/rest/v1/sessions/${sessionId}/messages`,
      { message },
    );
  }

  async getSession(sessionId: string): Promise<Session> {
    return this.request<Session>('GET', `${this.baseUrl}/rest/v1/sessions/${sessionId}`);
  }

  /**
   * Fetches the final assistant message for a thread, or null if the agent is
   * still working. `finalMessageHref` must be the `_links.final_message.href`
   * handed back by create/follow-up — it already carries the right thread id
   * and type/role filter.
   */
  async fetchFinalMessage(finalMessageHref: string): Promise<string | null> {
    const list = await this.request<MessageList>('GET', this.resolveHref(finalMessageHref));
    const item = list.items?.[0];
    return item ? item.message : null;
  }

  private async request<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
    const raw = await this.requestRaw(method, url, body);
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new BlocksApiError(`${method} ${url} returned a non-JSON body.`, 200, raw);
    }
  }

  private async requestRaw(method: 'GET' | 'POST', url: string, body?: unknown): Promise<string> {
    const headers = {
      authorization: `ApiKey ${this.apiKey}`,
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    };

    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let status: number;
      let text: string;
      let retryAfter: string | undefined;

      try {
        const response =
          method === 'GET'
            ? await this.http.get(url, headers)
            : await this.http.post(url, JSON.stringify(body ?? {}), headers);
        status = response.message.statusCode ?? 0;
        text = await response.readBody();
        retryAfter = response.message.headers['retry-after'] as string | undefined;
      } catch (error) {
        // Connection reset, DNS blip, socket timeout — worth another go.
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt === MAX_ATTEMPTS) break;
        await this.backoff(attempt, undefined, `${method} ${url} failed: ${lastError.message}`);
        continue;
      }

      if (status >= 200 && status < 300) return text;

      if (FATAL_STATUSES.has(status)) {
        throw new BlocksApiError(
          `${method} ${url} failed with ${status}: ${describeBody(text)}`,
          status,
          text,
        );
      }

      lastError = new BlocksApiError(
        `${method} ${url} failed with ${status}: ${describeBody(text)}`,
        status,
        text,
      );
      if (attempt === MAX_ATTEMPTS) break;
      await this.backoff(attempt, retryAfter, `${method} ${url} returned ${status}`);
    }

    throw lastError ?? new Error(`${method} ${url} failed.`);
  }

  private async backoff(attempt: number, retryAfter: string | undefined, reason: string) {
    const delay = retryAfterMs(retryAfter) ?? jitteredBackoff(attempt);
    this.log(`${reason} — retrying in ${Math.round(delay / 1000)}s (attempt ${attempt}/${MAX_ATTEMPTS}).`);
    await this.sleep(delay);
  }
}

/** `Retry-After` is either delta-seconds or an HTTP date. */
export function retryAfterMs(header: string | undefined): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, MAX_BACKOFF_MS);
  const date = Date.parse(header);
  if (Number.isNaN(date)) return null;
  return Math.min(Math.max(date - Date.now(), 0), MAX_BACKOFF_MS);
}

export function jitteredBackoff(attempt: number, random: () => number = Math.random): number {
  const capped = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  // Full jitter, so a fleet of matrix jobs does not resynchronise on retry.
  return Math.round(capped * (0.5 + random() * 0.5));
}

/** Surfaces the API's `{ "error": "..." }` body without dumping raw HTML. */
function describeBody(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    const detail = parsed.error ?? parsed.message;
    if (typeof detail === 'string' && detail) return detail;
  } catch {
    // fall through to the raw preview
  }
  return text.slice(0, 500) || '(empty body)';
}
