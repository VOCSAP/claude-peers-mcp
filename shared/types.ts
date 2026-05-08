// Unique ID for each Claude Code instance (generated on registration)
export type PeerId = string;

export interface Peer {
  id: PeerId;
  pid: number; // PID of the bun server process (used for liveness check)
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  registered_at: string; // ISO timestamp
  last_seen: string; // ISO timestamp
  host: string; // Client hostname (for display)
  client_pid: number; // Client-side PID (for display, alongside host)
  project_key: string | null; // Normalized git remote URL, used for cross-PC repo matching
}

export interface Message {
  id: number;
  from_id: PeerId;
  to_id: PeerId;
  text: string;
  sent_at: string; // ISO timestamp
  delivered: boolean;
}

/**
 * Metadata sent by the client.ts to server.ts via the JSON handshake on stdin's first line.
 */
export interface ClientMeta {
  host: string;
  client_pid: number;
  cwd: string;
  git_root: string | null;
  git_branch: string | null;
  recent_files: string[];
  project_key: string | null;
  tty: string | null;
}

// --- Broker API types ---

export interface RegisterRequest {
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  host: string;
  client_pid: number;
  project_key: string | null;
}

export interface RegisterResponse {
  id: PeerId;
}

export interface HeartbeatRequest {
  id: PeerId;
}

export interface SetSummaryRequest {
  id: PeerId;
  summary: string;
}

export interface ListPeersRequest {
  scope: "machine" | "directory" | "repo";
  // The requesting peer's context (used for filtering)
  cwd: string;
  git_root: string | null;
  project_key?: string | null;
  exclude_id?: PeerId;
}

export interface SendMessageRequest {
  from_id: PeerId;
  to_id: PeerId;
  text: string;
}

export interface PollMessagesRequest {
  id: PeerId;
}

export interface PollMessagesResponse {
  messages: Message[];
}
