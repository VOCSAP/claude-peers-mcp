# Plan d'action -- claude-peers-mcp : hébergement distant + migration Anthropic

## Objectif

Refondre claude-peers-mcp pour permettre :
1. Le broker hébergé sur une LXC distante (Debian 13, broker-host) accessible via SSH stdio depuis plusieurs PCs clients (Windows perso + Windows pro).
2. Chaque session Claude Code conserve son contexte LOCAL (cwd, git_root, branche, fichiers récents) tout en partageant la "mailbox" centralisée.
3. La migration de l'auto-summary OpenAI vers Anthropic, avec fallback heuristique si l'API est indisponible.
4. La configurabilité complète via variables d'env + fichier settings (port, host SSH, chemin server distant) pour faciliter le fork public.

## Décisions actées (validées avec l'utilisateur)

- **Architecture** : option A3 -- séparation claire `client.ts` (PC client) / `server.ts` (LXC distant) / `broker.ts` (LXC distant).
- **Transport client<->server** : SSH stdio. Le client.ts spawn `ssh root@broker-host bun /srv/claude-peers/server.ts` et forward stdio entre Claude Code et SSH.
- **Handshake métadonnées** : première ligne JSON sur stdin (`{"client_meta": {...}}\n`) avant le protocole MCP standard, contenant cwd, git_root, git_branch, recent_files, host, client_pid, project_key.
- **Identité projet partagée** : `project_key` = URL remote git normalisée (ex: `github.com/vocsap/claude-peers-mcp`), calculée client-side. Remplace `git_root` pour le scope `repo` afin de matcher cross-PC.
- **Champs ajoutés à la table peers** : `host` (nom d'hote client), `client_pid` (PID local au client), `project_key` (identifiant projet partagé).
- **PID** : double tracking. Le `pid` du peer est celui du process bun distant (utilisé pour `process.kill(pid, 0)` -> cleanup). L'affichage humain utilise `host + client_pid` (ex: `pc-perso - PID: 12847`).
- **Auto-summary** : conservée. Anthropic API key sur la LXC dans `/etc/claude-peers/claude-peers.env`. Modele `claude-haiku-4-5-20251001`. Fallback heuristique sans LLM si API en echec (utilise `git_root` basename + branch + recent_files).
- **Deploiement LXC** : sources clonees dans `/srv/claude-peers/`, broker en service systemd, DB SQLite dans `/var/lib/claude-peers/peers.db`. Execution sous root (risque accepte, LAN segmente OPNsense).
- **Configurabilite** : module `shared/config.ts` resout `env > fichier settings > defaut`. Fichier settings dans `$XDG_CONFIG_HOME/claude-peers/config.json` (Linux/macOS) ou `%APPDATA%\claude-peers\config.json` (Windows).
- **Suppression** : `summarize_with_claude.ts` (orphelin a la racine) supprime apres migration. Fichier `index.ts` a la racine garde son role d'index si pertinent (a verifier).
- **`--dangerously-skip-permissions`** : documente comme optionnel dans le README (n'affecte pas les sources, uniquement le lancement de Claude Code).

## Variables d'environnement / config a supporter

| Variable | Cote | Role | Defaut |
|---|---|---|---|
| `CLAUDE_PEERS_PORT` | broker / server / cli | port broker HTTP | 7899 |
| `CLAUDE_PEERS_DB` | broker | chemin SQLite | `/var/lib/claude-peers/peers.db` ou `~/.claude-peers.db` |
| `CLAUDE_PEERS_REMOTE` | client | `user@host[:port]` du SSH distant | (obligatoire en mode client) |
| `CLAUDE_PEERS_SSH_OPTS` | client | options SSH supplementaires (CSV) | (vide) |
| `CLAUDE_PEERS_REMOTE_SERVER_PATH` | client | chemin de `server.ts` sur le distant | `/srv/claude-peers/server.ts` |
| `ANTHROPIC_API_KEY` | server | clef API auto-summary | (optionnel, fallback heuristique) |

## Phases

### Phase 1 -- Refactor base : config, types, summarize Anthropic
**Statut** : complete

Sous-taches :
- 1.1 Creer `shared/config.ts` : fonction `loadConfig()` resolvant env > fichier > defauts. Export typed `Config`. Tolerant si fichier absent.
- 1.2 Etendre `shared/types.ts` : `RegisterRequest` recoit `host`, `client_pid`, `project_key`. `Peer` recoit ces memes champs.
- 1.3 Reecrire `shared/summarize.ts` en version Anthropic (modele `claude-haiku-4-5-20251001`), avec fallback heuristique.
  - Helper `heuristicSummary({ git_root, git_branch, recent_files, cwd })` retourne une string toujours non-vide.
  - `generateSummary` tente Anthropic ; sur echec/null, retourne `heuristicSummary(...)`.
  - Renommer le fichier ou garder `summarize.ts` ? Garder `summarize.ts` -- on remplace son contenu.
- 1.4 Supprimer `summarize_with_claude.ts` (a la racine, orphelin).
- 1.5 Corriger les commentaires obsoletes mentionnant `gpt-5.4-nano` (server.ts:466, etc.).

Critere de validation : projet compile, `bun shared/summarize.ts` (smoke) ou test minimal.

### Phase 2 -- Broker : schema, host/client_pid/project_key, scope repo cross-PC
**Statut** : complete

Sous-taches :
- 2.1 Migration schema SQLite : ajouter colonnes `host TEXT NOT NULL DEFAULT ''`, `client_pid INTEGER NOT NULL DEFAULT 0`, `project_key TEXT`. Migration transparente : `ALTER TABLE peers ADD COLUMN ...` avec `try/catch` pour idempotence.
- 2.2 Adapter `handleRegister` pour lire et stocker les nouveaux champs.
- 2.3 Adapter `handleListPeers` :
  - scope `repo` : matcher sur `project_key` si fourni, fallback sur `git_root`.
  - Conserver le filtre `process.kill(pid, 0)` (le `pid` est celui du process bun distant, donc local au broker -> valide).
- 2.4 Ajouter prepared statement `selectPeersByProjectKey`.
- 2.5 `handleListPeers` : ajouter le `project_key` du requestant dans `ListPeersRequest`.
- 2.6 Verifier que `cleanStalePeers` reste correct.

Critere de validation : enregistrer manuellement 2 peers fictifs avec memes `project_key` mais `cwd` differents -> `list-peers scope=repo` doit les retourner tous deux.

### Phase 3 -- server.ts : reception du handshake client_meta, suppression detection locale
**Statut** : complete

Sous-taches :
- 3.1 Au demarrage de `main()`, lire la premiere ligne stdin : parser comme JSON, extraire `client_meta`. Timeout 5s. Si absent ou parse error -> log + exit code 1.
- 3.2 Apres lecture, brancher `StdioServerTransport` sur le stdin/stdout standard (la premiere ligne deja consommee).
- 3.3 Supprimer / contourner `getGitRoot`, `getTty` (deprecies). Le contexte vient entierement du `client_meta`.
- 3.4 `getGitBranch` et `getRecentFiles` -> pareil, plus appeles ici (deplaces cote client).
- 3.5 `generateSummary` recoit le `client_meta` directement (pas de re-detection locale).
- 3.6 Variables locales `myCwd`, `myGitRoot` remplacees par les valeurs du `client_meta`.
- 3.7 `handleRegister` envoie `host`, `client_pid`, `project_key` au broker.
- 3.8 Affichage `list_peers` : utiliser `host` + `client_pid` au lieu du `pid` distant.

Point d'attention : verifier que `mcp.connect(new StdioServerTransport())` ne tente pas de relire la premiere ligne -- le SDK MCP doit accepter un stdin "deja partiellement consomme". Voir si on doit utiliser un readline custom ou si on peut decouper le stream.

Critere de validation : appeler manuellement `bun server.ts < handshake.json` simule un client, observer l'enregistrement broker.

### Phase 4 -- client.ts : nouveau fichier, detection locale + spawn SSH + forward stdio
**Statut** : complete

Sous-taches :
- 4.1 Creer `client.ts` a la racine du projet.
- 4.2 Au demarrage : lire `loadConfig()`, exiger `CLAUDE_PEERS_REMOTE` defini.
- 4.3 Detection locale :
  - `cwd = process.cwd()`
  - `git_root = getGitRoot(cwd)`
  - `git_branch = getGitBranch(cwd)`
  - `recent_files = getRecentFiles(cwd, 10)`
  - `host = os.hostname()`
  - `client_pid = process.pid`
  - `project_key = computeProjectKey(cwd)` -- via `git remote get-url origin`, normalisation
- 4.4 Implementer `computeProjectKey` :
  - `git remote get-url origin` -> ex `git@github.com:vocsap/claude-peers-mcp.git`
  - Normaliser : strip protocole, strip `.git`, lowercase host -> `github.com/vocsap/claude-peers-mcp`
  - Si pas de remote : fallback `null` (le scope `repo` retombera sur `git_root`).
- 4.5 Spawn SSH : `ssh [opts] user@host bun <remote_server_path>`. Utiliser `Bun.spawn` avec `stdio: ["pipe", "pipe", "inherit"]`.
- 4.6 Ecrire le handshake JSON sur stdin de SSH : `{"client_meta": {...}}\n`.
- 4.7 Forward bidirectionnel : `process.stdin -> ssh.stdin`, `ssh.stdout -> process.stdout`. Pas de parsing.
- 4.8 Propager SIGINT/SIGTERM au process SSH. Sur exit du process SSH, exit du client avec meme code.
- 4.9 Logger sur stderr seulement (jamais stdout, c'est le canal MCP).

Critere de validation : `CLAUDE_PEERS_REMOTE=root@broker-host bun client.ts` doit lancer un MCP fonctionnel cote distant et logger l'enregistrement broker.

### Phase 5 -- cli.ts : adapter affichage, lire config
**Statut** : complete

Sous-taches :
- 5.1 `cli.ts` lit `loadConfig()` au demarrage.
- 5.2 Ajouter une notion de "mode distant" : si `CLAUDE_PEERS_REMOTE` defini, le CLI execute en local mais avise l'utilisateur que le broker est distant (les commandes `kill-broker` n'ont pas de sens locale). Alternative simple : documenter "lancer cli.ts via SSH sur la LXC". Choix : documenter, garder cli.ts inchange en termes de transport (il continue a parler 127.0.0.1:7899 -- donc utile uniquement sur la LXC ou en cas de broker local).
- 5.3 Adapter l'affichage `peers` et `status` : montrer `host` + `client_pid` au lieu du pid brut.
- 5.4 `kill-broker` : le `lsof` ne marche pas sous Windows. Documenter "Linux/macOS only".

Critere de validation : `ssh root@broker-host "cd /srv/claude-peers && bun cli.ts status"` retourne les peers avec affichage correct.

### Phase 6 -- Deploiement LXC broker-host
**Statut** : pending (execution manuelle utilisateur)

Sous-taches :
- 6.1 SSH root@broker-host -- verifier que bun est installe (`bun --version`). Si non : `curl -fsSL https://bun.sh/install | bash`.
- 6.2 `git clone https://github.com/vocsap/claude-peers-mcp.git /srv/claude-peers/`. Branche : main (ou notre branche de travail).
- 6.3 `cd /srv/claude-peers && bun install`.
- 6.4 Creer `/var/lib/claude-peers/` (DB SQLite).
- 6.5 Creer `/etc/claude-peers/claude-peers.env` avec `ANTHROPIC_API_KEY=...` et `CLAUDE_PEERS_DB=/var/lib/claude-peers/peers.db`. Permissions 600.
- 6.6 Creer `/etc/systemd/system/claude-peers-broker.service` :
  ```
  [Unit]
  Description=claude-peers broker daemon
  After=network.target
  
  [Service]
  Type=simple
  User=root
  EnvironmentFile=/etc/claude-peers/claude-peers.env
  ExecStart=/usr/local/bin/bun /srv/claude-peers/broker.ts
  Restart=on-failure
  RestartSec=5
  
  [Install]
  WantedBy=multi-user.target
  ```
- 6.7 `systemctl daemon-reload && systemctl enable --now claude-peers-broker.service`.
- 6.8 Verifier : `systemctl status claude-peers-broker` + `curl http://127.0.0.1:7899/health`.
- 6.9 Verifier que le port 7899 est libre **avant** : `ss -tlnp | grep -E ':7899\b' || echo libre`. (l'utilisateur a confirme que c'est libre)

Critere de validation : `curl http://127.0.0.1:7899/health` retourne `{"status":"ok","peers":0}` depuis la LXC. Service redemarre automatiquement apres `kill -9`.

### Phase 7 -- Test end-to-end multi-PC
**Statut** : pending (execution manuelle utilisateur)

Sous-taches :
- 7.1 Sur PC perso : configurer `.mcp.json` du projet test :
  ```json
  {
    "claude-peers": {
      "command": "bun",
      "args": ["D:/AI/MCPServer/claude-peers-mcp/client.ts"],
      "env": {
        "CLAUDE_PEERS_REMOTE": "root@broker-host"
      }
    }
  }
  ```
- 7.2 Lancer Claude Code. Verifier l'enregistrement via `ssh root@broker-host "cd /srv/claude-peers && bun cli.ts peers"`.
- 7.3 Lancer une seconde session Claude Code (autre projet, meme PC). Verifier `list_peers scope=machine`.
- 7.4 Lancer une session sur PC pro (apres deploiement client la). Verifier `list_peers scope=machine` retourne les 3 peers.
- 7.5 Test cross-PC scope `repo` : meme repo git clone sur perso et pro -> `list_peers scope=repo` doit matcher via `project_key`.
- 7.6 Test send_message cross-PC : envoi depuis perso -> reception sur pro via canal claude/channel.

Critere de validation : send_message cross-PC fonctionne, summary visible, host correctement affiche.

### Phase 9 -- Auto-summary multi-provider (Anthropic / OpenAI-compatible / Ollama via LiteLLM)
**Statut** : complete

Sous-taches :
- 9.1 Etendre `shared/config.ts` : ajout `summary_provider` (auto|anthropic|openai-compat|none), `summary_base_url`, `summary_api_key`, alias `summary_model` qui remplace `anthropic_model`.
- 9.2 Auto-detection : si provider=auto, base_url defini => openai-compat ; sinon si ANTHROPIC_API_KEY defini => anthropic ; sinon none.
- 9.3 Refactor `shared/summarize.ts` : extraire `callAnthropic` et `callOpenAICompat`, router via le provider resolu, conserver l'heuristique en fallback.
- 9.4 Backward-compat : `CLAUDE_PEERS_ANTHROPIC_MODEL` reste reconnu comme alias de `CLAUDE_PEERS_SUMMARY_MODEL` ; `ANTHROPIC_API_KEY` reste reconnu pour summary_api_key quand provider=anthropic.
- 9.5 README : ajouter trois exemples (Anthropic direct / LiteLLM proxy / Ollama direct OpenAI-compat). Mettre a jour la table env.
- 9.6 CLAUDE.md projet : mettre a jour la ligne summarize.

### Phase 8 -- README et documentation
**Statut** : complete

Sous-taches :
- 8.1 Reecrire la section "Running" du README avec :
  - Mode local (broker local) : configuration historique.
  - Mode client/distant : env `CLAUDE_PEERS_REMOTE`, exemple `.mcp.json`, prerequis SSH key.
  - Section deploiement serveur : steps systemd, structure /srv et /etc.
- 8.2 Documenter toutes les variables d'env (table).
- 8.3 Documenter le fichier de config et son chemin par OS.
- 8.4 Documenter `--dangerously-skip-permissions` comme **optionnel** : utile pour eviter les prompts a chaque message recu, mais non requis fonctionnellement.
- 8.5 Documenter `--dangerously-load-development-channels server:claude-peers` : indispensable pour les notifications push (sans ce flag, fallback `check_messages` manuel).
- 8.6 Mentionner la migration OpenAI -> Anthropic dans une section CHANGELOG ou en haut du README pour les forkers.
- 8.7 Section "Architecture" mise a jour : diagramme client.ts <-> ssh <-> server.ts <-> broker.ts.

Critere de validation : lecture du README par un tiers non implique permet de deployer sans aide externe.

## Fichiers crees / modifies

| Fichier | Action |
|---|---|
| `shared/config.ts` | CREATE |
| `shared/types.ts` | MODIFY (champs host, client_pid, project_key) |
| `shared/summarize.ts` | REWRITE (Anthropic + fallback heuristique) |
| `summarize_with_claude.ts` | DELETE |
| `broker.ts` | MODIFY (schema, scope repo via project_key, prepared stmts) |
| `server.ts` | REFACTOR (handshake client_meta, suppression detection locale) |
| `client.ts` | CREATE |
| `cli.ts` | MODIFY (affichage host/client_pid, lecture config) |
| `README.md` | REWRITE significatif |
| `package.json` | MAYBE (scripts pour client/server/broker) |
| `index.ts` | VERIFY (utilite ?) |
| `.mcp.json` | UPDATE (exemple client) |

## Risques et points d'attention

1. **Premiere ligne stdin avant MCP transport** : verifier que `StdioServerTransport` accepte un stdin partiellement consomme. Si non, encapsuler dans un Transform stream ou negocier le handshake en-tete differemment (ex: env var transmise via SSH `SendEnv` -- mais SSH par defaut n'accepte pas les env arbitraires).
2. **`SendEnv` SSH** : par defaut sshd n'accepte que `LANG` et `LC_*`. Soit on utilise stdin handshake (choix actuel), soit on convertit les meta en flags CLI passes au serveur (`bun server.ts --client-cwd ...`). Si Phase 3.1 echoue, fallback flags CLI.
3. **Latence SSH** : chaque session Claude Code etablit une connexion SSH. Si le LAN est lent, le startup MCP peut depasser le timeout cote Claude Code. Activer multiplexing SSH (`ControlMaster auto`, `ControlPath ~/.ssh/cm-%r@%h:%p`, `ControlPersist 10m`) cote client peut aider. A documenter.
4. **PID distant et reconciliation** : si la LXC reboot, tous les PIDs distants invalident d'un coup. `cleanStalePeers` les supprimera proprement, mais les clients verront leurs sessions disparaitre du broker. Acceptable (Claude Code peut re-register au prochain heartbeat -- a verifier dans le code).
5. **Auto-summary `claude-haiku-4-5-20251001`** : verifier que l'API Anthropic accepte ce nom de modele dans le contexte du compte de l'utilisateur (parfois les modeles ne sont accessibles qu'apres provision tier).
6. **Idempotence du `ALTER TABLE`** : SQLite ne supporte pas `IF NOT EXISTS` sur ADD COLUMN avant la version 3.35. Bun:sqlite est recent donc OK. Sinon : try/catch.

## Ordre d'execution conseille

1. Phase 1 (sans deploiement, tout local).
2. Phase 2 (broker peut etre teste localement avec un script de simulation).
3. Phase 3 (server.ts).
4. Phase 4 (client.ts).
5. Phase 5 (cli.ts).
6. Phase 6 (deploiement LXC).
7. Phase 7 (tests E2E multi-PC).
8. Phase 8 (README, fait en parallele a partir de la phase 4 idealement).

## Validations utilisateur attendues avant chaque phase importante

- Avant Phase 6 : confirmer que la LXC broker-host est dispo et que je peux y SSH en root.
- Apres Phase 7 : retour utilisateur sur le comportement reel multi-PC, ajustements UX du `list_peers`.
- Apres Phase 8 : relecture du README avant push / fork public.
