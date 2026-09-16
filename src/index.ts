import * as core from '@actions/core';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { BlocksApiError, BlocksClient } from './client';
import { InputError, parseInputs, type ActionInputs, type RawInputs } from './inputs';
import { AGENT_ALIASES, type RunResult } from './types';

const INPUT_NAMES = [
  'blocks_api_key',
  'prompt',
  'agent',
  'agent_id',
  'session_id',
  'title',
  'session_group_id',
  'is_private',
  'timeout_minutes',
  'poll_interval_seconds',
  'fail_on_timeout',
  'api_base_url',
] as const;

function readInputs(): RawInputs {
  const raw: RawInputs = {};
  for (const name of INPUT_NAMES) raw[name] = core.getInput(name);
  return raw;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Logs text that originated from the agent or the API. The runner treats any
 * log line starting with `::` as a workflow command (`add-mask`, `error`,
 * `stop-commands`, ...), so untrusted text is fenced in a stop-commands block
 * with a random token before it is written.
 */
export function logUntrusted(text: string): void {
  const token = randomUUID();
  core.info(`::stop-commands::${token}`);
  core.info(text);
  core.info(`::${token}::`);
}

/** `timeout_minutes` accepts fractions, so "0 minutes" is a real possibility. */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  const minutes = ms / 60_000;
  return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} minute(s)`;
}

/**
 * Starts (or resumes) a session and waits for the agent's final message.
 *
 * `onSessionStarted` fires as soon as the session id is known — the caller uses
 * it to publish outputs before the long poll, so a job that later times out
 * still hands a usable `session_id` to downstream `needs.*` consumers.
 */
export async function run(
  inputs: ActionInputs,
  client: BlocksClient,
  onSessionStarted: (partial: Pick<RunResult, 'session_id' | 'thread_id' | 'session_html_url'>) => void,
  deps: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<RunResult> {
  const now = deps.now ?? Date.now;
  const wait = deps.sleep ?? sleep;

  let sessionId: string;
  let threadId: string | null;
  let finalMessageHref: string | null;
  let sessionHtmlUrl: string;
  let pullRequests: string[];

  if (inputs.sessionId) {
    core.info(`Posting a follow-up message to session ${inputs.sessionId}.`);
    const message = await client.postMessage(inputs.sessionId, inputs.prompt);
    const session = await client.getSession(inputs.sessionId);
    sessionId = inputs.sessionId;
    threadId = message.chat_thread_id ?? null;
    finalMessageHref = message._links?.final_message?.href ?? null;
    sessionHtmlUrl = session.session_html_url;
    pullRequests = session.pull_requests ?? [];
  } else {
    core.info('Creating a new Blocks session.');
    const session = await client.createSession({
      message: inputs.prompt,
      ...(inputs.agent ? { agent_name: inputs.agent } : {}),
      ...(inputs.agentId ? { agent_id: inputs.agentId } : {}),
      ...(inputs.title ? { title: inputs.title } : {}),
      ...(inputs.sessionGroupId ? { session_group_id: inputs.sessionGroupId } : {}),
      ...(inputs.isPrivate ? { is_private: true } : {}),
    });
    sessionId = session.id;
    threadId = session.thread_id;
    finalMessageHref = session._links?.final_message?.href ?? null;
    sessionHtmlUrl = session.session_html_url;
    pullRequests = session.pull_requests ?? [];
  }

  onSessionStarted({ session_id: sessionId, thread_id: threadId, session_html_url: sessionHtmlUrl });
  logUntrusted(`Session ${sessionId} — ${sessionHtmlUrl}`);

  if (!finalMessageHref) {
    throw new Error(
      `Session ${sessionId} came back without a final_message link, so there is no thread to ` +
        'wait on. This usually means the session was created but no thread was committed.',
    );
  }

  const deadline = now() + inputs.timeoutMs;
  core.info(
    `Waiting up to ${formatDuration(inputs.timeoutMs)} for the agent's final message ` +
      `(polling every ${Math.round(inputs.pollIntervalMs / 1_000)}s).`,
  );

  while (true) {
    const finalMessage = await client.fetchFinalMessage(finalMessageHref);
    if (finalMessage !== null) {
      core.info('Agent finished.');
      // Re-read the session: `pull_requests` is only populated once the agent
      // has actually opened them, which is after the create call returned.
      try {
        pullRequests = (await client.getSession(sessionId)).pull_requests ?? [];
      } catch (error) {
        core.warning(`Could not refresh pull_requests: ${(error as Error).message}`);
      }
      return {
        session_id: sessionId,
        thread_id: threadId,
        session_html_url: sessionHtmlUrl,
        final_message: finalMessage,
        pull_requests: pullRequests,
        status: 'completed',
      };
    }

    const remaining = deadline - now();
    if (remaining <= 0) break;

    core.info(`Still running — ${Math.ceil(remaining / 1_000)}s of budget left.`);
    await wait(Math.min(inputs.pollIntervalMs, remaining));
  }

  return {
    session_id: sessionId,
    thread_id: threadId,
    session_html_url: sessionHtmlUrl,
    final_message: '',
    pull_requests: pullRequests,
    status: 'timed_out',
  };
}

function publish(partial: Partial<RunResult>): void {
  if (partial.session_id !== undefined) core.setOutput('session_id', partial.session_id);
  if (partial.thread_id !== undefined) core.setOutput('thread_id', partial.thread_id ?? '');
  if (partial.session_html_url !== undefined) {
    core.setOutput('session_html_url', partial.session_html_url);
  }
  if (partial.final_message !== undefined) core.setOutput('final_message', partial.final_message);
  if (partial.pull_requests !== undefined) {
    core.setOutput('pull_requests', JSON.stringify(partial.pull_requests));
  }
  if (partial.status !== undefined) core.setOutput('status', partial.status);
}

async function writeSummary(result: RunResult): Promise<void> {
  try {
    const summary = core.summary
      .addHeading('Blocks agent session', 3)
      .addLink(result.session_id, result.session_html_url);
    if (result.pull_requests.length) {
      summary.addList(result.pull_requests.map((url) => `<a href="${url}">${url}</a>`));
    }
    if (result.final_message) {
      summary.addHeading('Final message', 4).addQuote(result.final_message);
    }
    await summary.write();
  } catch (error) {
    // No GITHUB_STEP_SUMMARY (act, local harnesses) — not worth failing over.
    core.debug(`Could not write the step summary: ${(error as Error).message}`);
  }
}

export async function main(): Promise<void> {
  // Mask before anything else can echo it, including input validation errors.
  const apiKey = core.getInput('blocks_api_key');
  if (apiKey) core.setSecret(apiKey);
  // The client sends the trimmed value, so mask that form as well.
  if (apiKey.trim() && apiKey.trim() !== apiKey) core.setSecret(apiKey.trim());

  let inputs: ActionInputs;
  try {
    inputs = parseInputs(readInputs());
  } catch (error) {
    core.setFailed((error as Error).message);
    return;
  }

  if (inputs.sessionId && (inputs.agent || inputs.agentId)) {
    core.warning('"session_id" is set, so "agent"/"agent_id" are ignored — the session keeps its own agent.');
  }

  const client = new BlocksClient({
    apiKey: inputs.apiKey,
    baseUrl: inputs.apiBaseUrl,
    log: (message) => core.info(message),
  });

  try {
    const result = await run(inputs, client, publish);
    // `run` already published session_id / thread_id / session_html_url through
    // the callback; only the outputs that need the final message are left.
    publish({
      final_message: result.final_message,
      pull_requests: result.pull_requests,
      status: result.status,
    });
    await writeSummary(result);

    if (result.status === 'timed_out') {
      const message =
        `Timed out after ${formatDuration(inputs.timeoutMs)} waiting for the agent. ` +
        `The session is still running at ${result.session_html_url}.`;
      if (inputs.failOnTimeout) core.setFailed(message);
      else core.warning(message);
      return;
    }

    logUntrusted(result.final_message);
  } catch (error) {
    core.setFailed(describeFailure(error));
  }
}

function describeFailure(error: unknown): string {
  if (error instanceof BlocksApiError && error.status === 422) {
    return (
      `${error.message}\n` +
      `Hint: "agent" must be one of ${AGENT_ALIASES.join(', ')}. ` +
      'The API has no workspace-default fallback, so it is required when creating a session.'
    );
  }
  if (error instanceof BlocksApiError && error.status === 401) {
    return `${error.message}\nHint: check that "blocks_api_key" is a valid, unexpired workspace API key.`;
  }
  if (error instanceof InputError || error instanceof Error) return error.message;
  return String(error);
}

// Only auto-run when Node was pointed straight at this bundle; the test suite
// imports the module instead. `import.meta.main` would be neater but only
// landed in Node 24.2, and the runner's node24 minor is not ours to pin.
//
// Node resolves symlinks when loading the main module, so `import.meta.url` is
// the real path while `argv[1]` may not be. Compare both forms, otherwise a
// symlinked action directory would silently skip `main()` and exit 0.
function isEntrypoint(argv1: string): boolean {
  const candidates = [argv1];
  try {
    candidates.push(realpathSync(argv1));
  } catch {
    // Not resolvable; fall through to the literal comparison.
  }
  return candidates.some((path) => pathToFileURL(path).href === import.meta.url);
}

const entrypoint = process.argv[1];
if (entrypoint && isEntrypoint(entrypoint)) {
  void main();
}
