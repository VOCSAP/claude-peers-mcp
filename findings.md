# Findings -- claude-peers-mcp refonte

## Etat du code source au demarrage (commit 640183f)

### broker.ts
- HTTP server sur `127.0.0.1:7899` (hostname dur, port via env `CLAUDE_PEERS_PORT`).
- DB SQLite `~/.claude-peers.db` (configurable via `CLAUDE_PEERS_DB`).
- Schema peers : `id, pid, cwd, git_root, tty, summary, registered_at, last_seen`.
- Cleanup via `process.kill(pid, 0)` toutes les 30s + a chaque list_peers.
- Endpoints : /register, /heartbeat, /set-summary, /list-peers, /send-message, /poll-messages, /unregister, /health.
- ScopeRepo matche sur `git_root` exact.

### server.ts
- Lit `CLAUDE_PEERS_PORT`, sinon 7899.
- `ensureBroker()` spawn un broker local si absent (best-effort, unref).
- Detecte `cwd`, `git_root`, `tty` localement (process.cwd, git rev-parse, ps).
- Genere une auto-summary via OpenAI (gpt-5.4-nano) au demarrage, non bloquant.
- Enregistre auprs du broker, polling messages 1s, heartbeat 15s.
- MCP : 4 tools (list_peers, send_message, set_summary, check_messages).
- Push via `mcp.notification({ method: "notifications/claude/channel" })`.

### shared/summarize.ts
- Utilise OPENAI_API_KEY -> gpt-5.4-nano (mauvais ID modele, semble etre une fabrication).
- Helpers `getGitBranch`, `getRecentFiles` (shellent vers git).

### summarize_with_claude.ts (a la racine)
- Version Anthropic prepare par un autre, **orphelin** (aucun import).
- Modele `claude-haiku-4-5-20250414` -- INCORRECT, le bon est `claude-haiku-4-5-20251001`.
- API call valide (x-api-key, anthropic-version).
- Helpers dupliques avec shared/summarize.ts.

### cli.ts
- Connecte 127.0.0.1:7899 (hardcoded).
- Commandes : status, peers, send, kill-broker.
- `kill-broker` utilise `lsof` (Linux/macOS only).

## Decisions architecturales actees

### Architecture A3 (separation client/server stricte)

```
PC client (Windows)                LXC Debian (broker-host)
+-----------------+                +-----------------------+
| Claude Code     |  stdio MCP     | bun /srv/.../server  |
|                 +<-------------->|                       |
| client.ts       |                |  HTTP 127.0.0.1:7899  |
|   (forward)     +-- ssh stdio ---+         |             |
+-----------------+                |         v             |
                                   |  bun /srv/.../broker  |
                                   |  SQLite               |
                                   +-----------------------+
```

- Client.ts : detection contexte local + spawn ssh + forward stdio.
- Server.ts : execute sur la LXC, recoit le contexte client via handshake JSON.
- Broker.ts : tourne en systemd sur la LXC.

### Project key

Cle de matching cross-PC pour le scope `repo`. Format normalise lisible :
- Source : `git remote get-url origin`
- Normalisation : 
  - `git@github.com:vocsap/claude-peers-mcp.git` -> `github.com/vocsap/claude-peers-mcp`
  - `https://github.com/vocsap/claude-peers-mcp.git` -> `github.com/vocsap/claude-peers-mcp`
  - `ssh://git@gitlab.com:22/group/proj.git` -> `gitlab.com/group/proj`
- Regex possible : capture host + path apres normalisation, lowercase, strip `.git$`.

### Handshake client_meta

Premiere ligne sur stdin avant le protocole MCP :
```json
{"client_meta": {
  "host": "pc-perso",
  "client_pid": 12847,
  "cwd": "D:\\AI\\MCPServer\\claude-peers-mcp",
  "git_root": "D:\\AI\\MCPServer\\claude-peers-mcp",
  "git_branch": "main",
  "recent_files": ["server.ts", "README.md"],
  "project_key": "github.com/vocsap/claude-peers-mcp"
}}
```

Le server.ts lit cette ligne via readline avant de brancher StdioServerTransport.

### Configuration centralisee (`shared/config.ts`)

Resolution : env > fichier > defaut.

Chemins fichier settings :
- Linux/macOS : `$XDG_CONFIG_HOME/claude-peers/config.json` ou `~/.config/claude-peers/config.json`
- Windows : `%APPDATA%\claude-peers\config.json`

Schema attendu :
```json
{
  "port": 7899,
  "db": "/var/lib/claude-peers/peers.db",
  "remote": "root@broker-host",
  "remote_server_path": "/srv/claude-peers/server.ts",
  "ssh_opts": ["-o", "ServerAliveInterval=30"]
}
```

### Auto-summary

- Anthropic (`claude-haiku-4-5-20251001`), 100 tokens max, system prompt court.
- Fallback heuristique si API echoue ou ANTHROPIC_API_KEY absent.
- Heuristique : `Working on '<basename(git_root)>' (branch: <branch>) -- recent: <files>`
- L'heuristique tourne SYNCHRONE avant l'enregistrement -> summary non vide des l'enregistrement broker.
- Anthropic tourne en background ; si reponse arrive, override la summary heuristique via `/set-summary`.

## Variables d'environnement / config

| Variable | Cote | Defaut | Note |
|---|---|---|---|
| `CLAUDE_PEERS_PORT` | broker/server/cli | 7899 | port broker |
| `CLAUDE_PEERS_DB` | broker | `/var/lib/claude-peers/peers.db` ou `~/.claude-peers.db` | chemin SQLite |
| `CLAUDE_PEERS_REMOTE` | client | (obligatoire) | `user@host[:port]` SSH |
| `CLAUDE_PEERS_SSH_OPTS` | client | "" | options SSH supplementaires (CSV) |
| `CLAUDE_PEERS_REMOTE_SERVER_PATH` | client | `/srv/claude-peers/server.ts` | chemin server.ts cote distant |
| `ANTHROPIC_API_KEY` | server | (optionnel) | clef API auto-summary |

## Risques identifies

1. **StdioServerTransport et stdin partiel** : verifier que MCP SDK supporte un stdin deja partiellement lu. Sinon, fallback flags CLI au lieu du handshake JSON.
2. **SSH `SendEnv` non disponible par defaut** : raison pour laquelle on prefere stdin handshake plutot qu'env vars.
3. **SSH multiplexing** pour reduire la latence : `ControlMaster auto`, `ControlPath ~/.ssh/cm-%r@%h:%p`, `ControlPersist 10m`. A documenter.
4. **Modele Haiku 4.5** : verifier disponibilite sur le compte de l'utilisateur.
5. **PC pro Windows** : politique d'execution PowerShell restrictive. Le client.ts est un script TS execute par bun, donc ne devrait pas etre concerne par les restrictions PS1.
6. **Re-register apres reboot LXC** : le code actuel n'a pas de logique de re-register cote server.ts si broker disparait apres l'enregistrement initial. A verifier en Phase 7.

## Notes techniques

- Le port 7899 est confirme libre sur la LXC broker-host (validation operateur).
- LXC tourne sous Debian 13, root SSH actif (cf. usage Kleos sur la meme LXC).
- Bun 1.x dispo sur la LXC (a verifier au moment du deploiement).
- SQLite 3.35+ supporte ALTER TABLE ADD COLUMN sans probleme (bun:sqlite -> recent).
