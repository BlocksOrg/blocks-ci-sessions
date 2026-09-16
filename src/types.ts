/** Agent aliases accepted by `POST /rest/v1/sessions` (`agent_name`). */
export const AGENT_ALIASES = [
  'claude',
  'codex',
  'gemini',
  'opencode',
  'cursor',
  'kimi',
  'sisyphus',
] as const;

export type AgentAlias = (typeof AGENT_ALIASES)[number];

export interface Link {
  href: string;
}

/** `POST|GET /rest/v1/sessions[/:id]` response. */
export interface Session {
  id: string;
  title: string;
  pull_requests: string[];
  source_url: string | null;
  is_archived: boolean;
  is_private: boolean;
  created_at: string;
  updated_at: string;
  /** Populated on create; always null on GET /sessions/:id. */
  thread_id: string | null;
  session_group_id: string | null;
  session_html_url: string;
  _links: {
    self: Link;
    messages: Link;
    thread: Link | null;
    final_message: Link | null;
  };
}

/** `POST /rest/v1/sessions/:id/messages` response. */
export interface SessionMessage {
  id: string;
  chat_id: string;
  chat_thread_id: string | null;
  task_id: string;
  role: string;
  type: string;
  message: string;
  ts: number | null;
  _links: {
    self: Link;
    thread: Link | null;
    final_message: Link | null;
  };
}

/** Item shape returned by the messages list endpoints. */
export interface MessageListItem {
  id: string;
  chat_thread_id?: string | null;
  role: string;
  type: string;
  message: string;
  ts?: number | null;
}

export interface MessageList {
  items: MessageListItem[];
  meta: { total: number; page: number; limit: number; total_pages: number };
}

export interface CreateSessionBody {
  message: string;
  agent_name?: AgentAlias;
  agent_id?: string;
  title?: string;
  session_group_id?: string;
  is_private?: boolean;
}

/**
 * What a single run of the action produced. `session_id` is known as soon as
 * the session exists, well before `final_message`.
 */
export interface RunResult {
  session_id: string;
  thread_id: string | null;
  session_html_url: string;
  final_message: string;
  pull_requests: string[];
  status: 'completed' | 'timed_out';
}
