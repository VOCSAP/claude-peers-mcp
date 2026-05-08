/**
 * Centralized configuration loader.
 *
 * Resolution order: env var > settings file > default.
 *
 * Settings file location:
 *   - Linux/macOS: $XDG_CONFIG_HOME/claude-peers/config.json
 *                  (default: ~/.config/claude-peers/config.json)
 *   - Windows:     %APPDATA%\claude-peers\config.json
 *
 * Settings file is JSON, all keys optional. See README for full schema.
 */

import { join } from "node:path";
import { homedir } from "node:os";

export type SummaryProvider = "auto" | "anthropic" | "openai-compat" | "none";

export interface Config {
  /** Broker HTTP port. */
  port: number;
  /** SQLite DB path (broker side). */
  db: string;
  /** SSH target for client.ts: "user@host[:port]". */
  remote: string | null;
  /** Path to server.ts on the remote host. */
  remote_server_path: string;
  /** Extra SSH options (passed as raw argv to ssh). */
  ssh_opts: string[];
  /** Auto-summary provider selection. "auto" resolves at call time. */
  summary_provider: SummaryProvider;
  /** Override base URL for openai-compat (e.g. LiteLLM/Ollama proxy). */
  summary_base_url: string | null;
  /** Override API key for the summary provider. */
  summary_api_key: string | null;
  /** Model name passed to the summary provider. */
  summary_model: string;
}

interface FileConfig {
  port?: number;
  db?: string;
  remote?: string;
  remote_server_path?: string;
  ssh_opts?: string[];
  summary_provider?: SummaryProvider;
  summary_base_url?: string;
  summary_api_key?: string;
  summary_model?: string;
  // Backward-compat alias for summary_model when provider is anthropic.
  anthropic_model?: string;
}

const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

function settingsFilePath(): string {
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA;
    if (appdata) {
      return join(appdata, "claude-peers", "config.json");
    }
    return join(homedir(), "AppData", "Roaming", "claude-peers", "config.json");
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) {
    return join(xdg, "claude-peers", "config.json");
  }
  return join(homedir(), ".config", "claude-peers", "config.json");
}

async function readFileConfig(): Promise<FileConfig> {
  const path = settingsFilePath();
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      return {};
    }
    const data = (await file.json()) as FileConfig;
    return data ?? {};
  } catch {
    return {};
  }
}

function defaultDbPath(): string {
  if (process.platform === "linux" || process.platform === "darwin") {
    return process.env.CLAUDE_PEERS_DB ?? "/var/lib/claude-peers/peers.db";
  }
  return join(homedir(), ".claude-peers.db");
}

function parseSshOpts(value: string | undefined): string[] | null {
  if (!value) return null;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseProvider(value: string | undefined): SummaryProvider | null {
  if (!value) return null;
  const v = value.toLowerCase();
  if (v === "auto" || v === "anthropic" || v === "openai-compat" || v === "none") {
    return v;
  }
  return null;
}

/**
 * Load configuration. Tolerant of missing file. Always returns a complete Config.
 */
export async function loadConfig(): Promise<Config> {
  const fileCfg = await readFileConfig();

  const port = parseInt(
    process.env.CLAUDE_PEERS_PORT ?? String(fileCfg.port ?? 7899),
    10
  );

  const db = process.env.CLAUDE_PEERS_DB ?? fileCfg.db ?? defaultDbPath();

  const remote = process.env.CLAUDE_PEERS_REMOTE ?? fileCfg.remote ?? null;

  const remote_server_path =
    process.env.CLAUDE_PEERS_REMOTE_SERVER_PATH ??
    fileCfg.remote_server_path ??
    "/srv/claude-peers/server.ts";

  const ssh_opts =
    parseSshOpts(process.env.CLAUDE_PEERS_SSH_OPTS) ??
    fileCfg.ssh_opts ??
    [];

  const summary_provider: SummaryProvider =
    parseProvider(process.env.CLAUDE_PEERS_SUMMARY_PROVIDER) ??
    fileCfg.summary_provider ??
    "auto";

  const summary_base_url =
    process.env.CLAUDE_PEERS_SUMMARY_BASE_URL ??
    fileCfg.summary_base_url ??
    null;

  const summary_api_key =
    process.env.CLAUDE_PEERS_SUMMARY_API_KEY ??
    fileCfg.summary_api_key ??
    null;

  // Backward-compat: CLAUDE_PEERS_ANTHROPIC_MODEL and `anthropic_model` key.
  const summary_model =
    process.env.CLAUDE_PEERS_SUMMARY_MODEL ??
    process.env.CLAUDE_PEERS_ANTHROPIC_MODEL ??
    fileCfg.summary_model ??
    fileCfg.anthropic_model ??
    DEFAULT_ANTHROPIC_MODEL;

  return {
    port,
    db,
    remote,
    remote_server_path,
    ssh_opts,
    summary_provider,
    summary_base_url,
    summary_api_key,
    summary_model,
  };
}

/**
 * Resolve the effective provider, taking "auto" into account.
 *
 * Auto-detection priority:
 *   1. summary_base_url defined  -> openai-compat
 *   2. summary_api_key OR ANTHROPIC_API_KEY defined -> anthropic
 *   3. otherwise -> none (heuristic only)
 */
export function resolveProvider(config: Config): Exclude<SummaryProvider, "auto"> {
  if (config.summary_provider !== "auto") return config.summary_provider;
  if (config.summary_base_url) return "openai-compat";
  if (config.summary_api_key || process.env.ANTHROPIC_API_KEY) return "anthropic";
  return "none";
}

/**
 * Build the broker URL from the resolved config (loopback only).
 */
export function brokerUrl(config: Config): string {
  return `http://127.0.0.1:${config.port}`;
}
