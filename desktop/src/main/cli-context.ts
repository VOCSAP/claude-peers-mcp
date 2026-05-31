// The launch context the bin/launch.js wrapper hands to the Electron main
// process. The wrapper resolves the *invocation* cwd (the project the user wants
// to scope sessions to) and forwards it via env, because the Electron main
// process's own process.cwd() is unrelated to where the user typed the command.

const PROJECT_DIR_ENV = 'CLAUDE_PEERS_DESK_PROJECT_DIR'
const SCOPE_ID_ENV = 'CLAUDE_PEERS_DESK_SCOPE_ID'

export interface CliContext {
  /** Absolute project directory new sessions default to (the invocation cwd). */
  projectDir: string
  /** Optional custom scope id. Absent => ephemeral scope (see scope.ts). */
  scopeId?: string
}

/**
 * Resolve the launch context. The env vars set by bin/launch.js take precedence;
 * a `--scope <id>` / `--scope=<id>` argv flag is honoured as a fallback. When no
 * project dir is supplied, the main process's cwd is used as a last resort.
 */
export function parseCliContext(argv: string[], env: NodeJS.ProcessEnv): CliContext {
  const envProject = env[PROJECT_DIR_ENV]?.trim()
  const envScope = env[SCOPE_ID_ENV]?.trim()

  let argScope: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--scope' && i + 1 < argv.length) {
      argScope = argv[i + 1]
      break
    }
    if (a.startsWith('--scope=')) {
      argScope = a.slice('--scope='.length)
      break
    }
  }

  const projectDir = envProject && envProject.length > 0 ? envProject : process.cwd()
  const scope = envScope && envScope.length > 0 ? envScope : argScope?.trim()
  const scopeId = scope && scope.length > 0 ? scope : undefined

  return { projectDir, scopeId }
}
