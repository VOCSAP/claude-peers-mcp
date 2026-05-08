# Progress -- claude-peers-mcp refonte

## Session 2026-05-08 -- Brainstorming, plan, implementation Phases 1-5 + 8

### Realise

**Brainstorming et plan** :
- Lecture complete du code source (broker.ts, server.ts, cli.ts, shared/summarize.ts, summarize_with_claude.ts).
- Brainstorming en 6 echanges pour acter l'architecture A3.
- Verification du SDK MCP : `StdioServerTransport` accepte un stream stdin custom -> handshake stdin viable via PassThrough.
- `index.ts` : juste un module marker, aucune logique. Mis a jour le commentaire.
- Redaction de `task_plan.md`, `findings.md`, `progress.md`.

**Phase 1 -- Refactor base** : COMPLETE
- `shared/types.ts` : ajout des champs `host`, `client_pid`, `project_key` aux `Peer`/`RegisterRequest`. Ajout du type `ClientMeta`. Ajout `project_key?` a `ListPeersRequest`.
- `shared/config.ts` : nouveau module `loadConfig()` avec resolution env > fichier > defaut. Helpers `brokerUrl()`. Support Linux/macOS/Windows pour le chemin du fichier settings.
- `shared/summarize.ts` : reecrit en Anthropic (`claude-haiku-4-5-20251001`), `heuristicSummary()` toujours non-vide, `generateSummary()` ne retourne plus `null` (heuristique en fallback). Ajout `computeProjectKey()` + `normalizeRemoteUrl()` exporte.
- `summarize_with_claude.ts` : supprime.
- `index.ts` : commentaire mis a jour pour mentionner client.ts.

**Phase 2 -- Broker** : COMPLETE
- `broker.ts` reecrit : utilise `loadConfig()`. Schema etendu avec `host`, `client_pid`, `project_key`. Migrations idempotentes via `ALTER TABLE` try/catch. Ajout `selectPeersByProjectKey`. `handleListPeers` : scope `repo` matche d'abord sur `project_key`, fallback `git_root`, fallback `cwd`. Cleanup PID-based conserve (pid = process bun local au broker).
- `mkdirSync` du dirname du DB pour creer `/var/lib/claude-peers/` si absent.
- Smoke test : broker demarre avec une DB fraiche, migration silencieuse OK.

**Phase 3 -- server.ts** : COMPLETE
- Lecture du handshake JSON sur stdin via `readHandshake()` qui retourne un PassThrough stream. Timeout 2s -> fallback detection locale (mode legacy single-host).
- Bascule vers `StdioServerTransport(passthrough, process.stdout)`.
- Suppression de `getTty()` (etait shell ps, ne marche pas Windows). Le tty vient du handshake.
- `getGitRoot` conserve uniquement pour le fallback legacy.
- Heuristique summary appliquee avant l'enregistrement broker -> peers ne voient jamais une summary vide.
- Anthropic en background : si meilleur, push via `/set-summary`.
- Channel notification enrichi avec `from_host`.
- `formatPeer()` affiche `host - PID: client_pid`.

**Phase 4 -- client.ts** : COMPLETE (nouveau fichier)
- Detection locale parallele : `cwd`, `git_root`, `git_branch`, `recent_files`, `project_key`, `host`, `client_pid`.
- Spawn ssh, ecrit le handshake JSON sur stdin du child.
- Forward bidirectionnel stdio Node Readable <-> Bun WritableStreamDefaultWriter.
- Propagation SIGINT/SIGTERM.
- `parseRemote()` parse "user@host[:port]".

**Phase 5 -- cli.ts** : COMPLETE
- Utilise `loadConfig()` au lieu d'env hard-coded.
- `formatPeerLine()` affiche `host - PID: client_pid` quand dispo, sinon `PID:<server_pid>`.
- Affichage du `project_key` dans `status` et `peers`.
- `kill-broker` rejette explicitement Windows (lsof manquant).

**Phase 8 -- README** : COMPLETE
- Reecriture complete avec deux modes (local / remote).
- Section deploiement LXC step-by-step (clone, env file, systemd unit).
- Section configuration (env vars + settings file + SSH multiplexing).
- Section flags Claude Code (`--dangerously-load-development-channels` recommande, `--dangerously-skip-permissions` optionnel).
- Section migration upstream (OpenAI -> Anthropic, nouveaux champs DB).
- Diagramme architecture client.ts <-> ssh <-> server.ts <-> broker.ts.

**Phase 9 -- Multi-provider auto-summary** : COMPLETE
- `shared/config.ts` : ajout `summary_provider`, `summary_base_url`, `summary_api_key`, `summary_model` (alias backward-compat de `anthropic_model`). Helper `resolveProvider(config)` pour auto-detection.
- `shared/summarize.ts` : split en `callAnthropic` + `callOpenAICompat`. `generateSummary(ctx, providerCfg)` route via `providerCfg.provider`. Format OpenAI-compat compatible LiteLLM, Ollama natif `/v1`, OpenRouter, vLLM, OpenAI.
- `server.ts` : appel via `resolveProvider(config)` + log du provider effectif.
- README : ajout section "Auto-summary" reecrite avec 3 exemples (Anthropic / LiteLLM proxy / Ollama direct) + table env vars etendue.
- CLAUDE.md : mise a jour section summarize.
- Backward-compat preserve : `ANTHROPIC_API_KEY`, `CLAUDE_PEERS_ANTHROPIC_MODEL`, `anthropic_model` (settings file) restent reconnus.

### Bug corrige pendant l'implementation

`normalizeRemoteUrl` v1 : la regex SCP-like matchait aussi les URLs `ssh://...`, donnant `gitlab.com/2222/group/proj` au lieu de `gitlab.com/group/proj`. Fix : ajout d'une garde `!s.includes("://")` et regex plus stricte (le user-part ne peut pas contenir `:` ou `/`). Les 6 cas de test passent maintenant.

### Validation

- Tous les entrypoints bundlent : `bun build broker.ts server.ts client.ts cli.ts` -> 0 erreur.
- Broker demarre proprement avec DB neuve (smoke local sur port 17899).
- normalizeRemoteUrl couvre les 6 formats courants.

### A faire -- Phase 6 (deploiement LXC) -- HORS PERIMETRE de cette session

L'utilisateur va executer manuellement, en suivant les instructions du README section "Quick start (remote)" :
1. SSH root@broker-host
2. Install bun si manquant
3. git clone vers /srv/claude-peers
4. mkdir -p /var/lib/claude-peers
5. Creer /etc/claude-peers/claude-peers.env (avec ANTHROPIC_API_KEY)
6. Creer le service systemd
7. systemctl enable --now claude-peers-broker.service
8. Verifier health sur 127.0.0.1:7899

### A faire -- Phase 7 (test E2E)

Apres deploiement Phase 6, tests cross-PC selon les criteres de validation du task_plan.md.

### Blockers

Aucun cote code. Phase 6 et 7 dependent de l'acces SSH a la LXC broker-host et de l'execution manuelle par l'utilisateur.

### Notes

- Le code reste compatible mode local : si on lance `bun server.ts` sans handshake, le timeout 2s declenche le fallback `detection locale`.
- Les `getGitBranch`/`getRecentFiles` sont desormais dupliques entre client.ts (utilises) et server.ts (uniquement en mode legacy fallback). Acceptable.
