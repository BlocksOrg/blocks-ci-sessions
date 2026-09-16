import { AGENT_ALIASES, type AgentAlias } from './types';

export interface ActionInputs {
  apiKey: string;
  apiBaseUrl: string;
  prompt: string;
  agent?: AgentAlias;
  agentId?: string;
  sessionId?: string;
  title?: string;
  sessionGroupId?: string;
  isPrivate: boolean;
  timeoutMs: number;
  pollIntervalMs: number;
  failOnTimeout: boolean;
}

/** Raw `with:` values, exactly as `core.getInput` hands them over. */
export type RawInputs = Record<string, string | undefined>;

export class InputError extends Error {}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function str(raw: RawInputs, key: string): string {
  return (raw[key] ?? '').trim();
}

function bool(raw: RawInputs, key: string, fallback: boolean): boolean {
  const value = str(raw, key).toLowerCase();
  if (value === '') return fallback;
  if (['true', 'yes', 'y', 'on', '1'].includes(value)) return true;
  if (['false', 'no', 'n', 'off', '0'].includes(value)) return false;
  throw new InputError(`Input "${key}" must be a boolean, got "${raw[key]}".`);
}

function num(raw: RawInputs, key: string, fallback: number, min: number): number {
  const value = str(raw, key);
  if (value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new InputError(`Input "${key}" must be a number, got "${value}".`);
  }
  if (parsed < min) {
    throw new InputError(`Input "${key}" must be at least ${min}, got ${parsed}.`);
  }
  return parsed;
}

function uuid(raw: RawInputs, key: string): string | undefined {
  const value = str(raw, key);
  if (value === '') return undefined;
  if (!UUID_RE.test(value)) {
    throw new InputError(`Input "${key}" must be a UUID, got "${value}".`);
  }
  return value;
}

/**
 * Validates and normalises the `with:` block.
 *
 * Creating a session needs an agent: `POST /rest/v1/sessions` rejects the
 * request unless one of `agent_name`, `agent_id` or `profile` is present, and
 * this action only exposes the first two. There is deliberately no default —
 * a hard-coded one would silently override whatever the workspace has
 * configured — so the caller has to pick, and we fail before touching the API.
 */
export function parseInputs(raw: RawInputs): ActionInputs {
  const apiKey = str(raw, 'blocks_api_key');
  if (!apiKey) throw new InputError('Input "blocks_api_key" is required.');

  const prompt = raw['prompt'] ?? '';
  if (prompt.trim() === '') throw new InputError('Input "prompt" is required and cannot be blank.');

  const agentRaw = str(raw, 'agent').toLowerCase();
  const agentId = uuid(raw, 'agent_id');
  const sessionId = uuid(raw, 'session_id');

  if (agentRaw && agentId) {
    throw new InputError('Inputs "agent" and "agent_id" are mutually exclusive — set only one.');
  }
  if (agentRaw && !(AGENT_ALIASES as readonly string[]).includes(agentRaw)) {
    throw new InputError(
      `Input "agent" must be one of ${AGENT_ALIASES.join(', ')} — got "${agentRaw}". ` +
        'For a custom workspace agent use "agent_id" instead.',
    );
  }
  if (!sessionId && !agentRaw && !agentId) {
    throw new InputError(
      'Creating a session requires an agent: set "agent" to one of ' +
        `${AGENT_ALIASES.join(', ')}, or set "agent_id" to a custom workspace agent UUID. ` +
        '(Neither is needed when resuming via "session_id".)',
    );
  }

  const apiBaseUrl = (str(raw, 'api_base_url') || 'https://api.blocks.team').replace(/\/+$/, '');
  const title = str(raw, 'title') || undefined;
  if (title && title.length > 200) {
    throw new InputError(`Input "title" must be at most 200 characters, got ${title.length}.`);
  }

  return {
    apiKey,
    apiBaseUrl,
    prompt,
    agent: agentRaw ? (agentRaw as AgentAlias) : undefined,
    agentId,
    sessionId,
    title,
    sessionGroupId: uuid(raw, 'session_group_id'),
    isPrivate: bool(raw, 'is_private', false),
    timeoutMs: num(raw, 'timeout_minutes', 30, 0.1) * 60_000,
    pollIntervalMs: num(raw, 'poll_interval_seconds', 5, 1) * 1_000,
    failOnTimeout: bool(raw, 'fail_on_timeout', true),
  };
}
