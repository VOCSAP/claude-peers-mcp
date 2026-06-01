// List Claude Code subagent names available for a project, by scanning the
// markdown files in <projectDir>/.claude/agents and ~/.claude/agents. The names
// (file basenames without .md) feed the CreateMenu agent dropdown, which turns a
// choice into a `--agent <name>` launch arg.

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function listAgents(projectDir: string, home: string = homedir()): string[] {
  const dirs = [join(projectDir, '.claude', 'agents'), join(home, '.claude', 'agents')]
  const names = new Set<string>()
  for (const dir of dirs) {
    try {
      if (!existsSync(dir)) continue
      for (const f of readdirSync(dir)) {
        if (f.toLowerCase().endsWith('.md')) names.add(f.slice(0, -3))
      }
    } catch {
      // unreadable dir -> skip
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b))
}
