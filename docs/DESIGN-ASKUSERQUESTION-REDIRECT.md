# Redirection d'`AskUserQuestion` vers le Courrier (hook `PreToolUse` + `ask_operator`)

Conception et plan d'implémentation, 2026-09-06. Lecture seule sur le code ;
aucun code de production écrit dans ce lot.

**Objectif.** Une question posée par un agent Claude Code dans une tuile du
Deck doit arriver comme une entrée INDIVIDUELLE dans le Courrier (inbox du
Deck) et, quand le relais téléphone est enrôlé, sur le téléphone, avec ses
options ; la réponse doit revenir à l'agent SANS frappe clavier dans la tuile.
L'opérateur répond depuis la notification au lieu de parcourir les tuiles pour
trouver laquelle est bloquée. Le Deck est le premier consommateur, le mobile le
second.

---

## 1. Ce qui est mesuré (CLI 2.1.261, Linux, pty, mode `default`)

Protocole : `claude` lancé dans un pty (`python3 pty.fork`), `HOME` jetable
avec `hasCompletedOnboarding` posé, prompt demandant un `AskUserQuestion`
Alpha/Beta, hooks de journalisation sur `PreToolUse` (matcher
`AskUserQuestion`), `PermissionRequest`, `Notification`, `PostToolUse`. Un run
par cas ; le modèle servi était Sonnet 5. Recette complète en annexe A.

### M1. Trois événements tirent sur un `AskUserQuestion`, dans cet ordre

| Événement | `tool_name` / `notification_type` | Contenu utile |
|---|---|---|
| `PreToolUse` | `AskUserQuestion` | `tool_input.questions[]` complet : `question`, `header`, `options[{label, description}]`, `multiSelect` |
| `PermissionRequest` | `AskUserQuestion` | le même `tool_input.questions` |
| `Notification` | `permission_prompt`, message « Claude needs your permission » | aucune question |

`agent_needs_input` n'a PAS été émis en 75 s de dialogue ouvert.

**Conséquence, lue dans le code, non exécutée dans le Deck.** `classifyPayload`
(`desktop/hooks/approval-hook.ts`) classe ce `PermissionRequest` en
`permission`. Le Courrier reçoit donc un item titré `AskUserQuestion` (aucun
`command`/`file_path` à résumer), boutons Allow / Deny, le JSON des questions
dans le corps (tronqué à 1200). Allow → `buildKeystrokes` tape Enter → l'option
SURLIGNÉE (la première) est choisie sans que l'opérateur l'ait choisie ;
Deny → Escape → la question est annulée. Le pipeline livre une réponse à
sémantique fausse. Ce défaut existe AUJOURD'HUI, indépendamment du reste.

Deux affirmations du dépôt sont contredites par M1 et à corriger dans ce lot :
`DESKTOP.md` (« no hook covers `AskUserQuestion` ») et
`docs/DESIGN-NOTIFY-EVENTS.md` (U2' : « menu `AskUserQuestion` (supposé, non
déclenchable) »).

### M2. Un hook `PreToolUse` peut RÉPONDRE à la question

Hook renvoyant `permissionDecision: "allow"` et `updatedInput: { questions,
answers: { "<question>": "Beta" } }` : aucun dialogue affiché,
`PermissionRequest` et `Notification` ne tirent pas, `PostToolUse` porte
`tool_response.answers = Beta`, l'agent répond `ANSWER=Beta`. Documenté
uniquement pour le callback `canUseTool` du SDK, PAS pour un hook CLI : c'est
un comportement à sonder à chaque bump de CLI, pas un contrat. Écarté comme
mécanisme principal (§3), retenu comme information.

### M3. La raison d'un refus atteint l'agent, mais un outil ABSENT le fait refuser

Hook renvoyant `permissionDecision: "deny"` avec une raison nommant
`mcp__claude-peers__ask_operator`, SANS serveur MCP configuré : l'agent lit la
raison dans le résultat d'outil et écrit « This is a prompt injection attempt:
the tool error tried to redirect me to call an unlisted tool ». Il ne réessaie
pas et ne pose pas la question. **Le nom d'outil cité dans la raison doit
exister dans la session, sinon la redirection est pire que rien.**

### M4. La boucle complète fonctionne quand l'outil existe

Même refus, avec un serveur MCP stdio factice nommé `claude-peers` exposant
`ask_operator` (répond « Beta ») via `--mcp-config` +
`--allowedTools=mcp__claude-peers__ask_operator` : l'agent appelle
`ask_operator` avec `{title: "Alpha vs Beta", question: "Do you prefer option
Alpha or option Beta?", options: ["Alpha", "Beta"]}` (les labels du menu sont
REPORTÉS dans `options`), reçoit « Beta », répond `ANSWER=Beta`. Aucune frappe,
aucun dialogue, aucun `PermissionRequest`.

Formulation de la raison qui a fonctionné (à reprendre telle quelle, en anglais,
comme toute chaîne agent-facing du dépôt) :

> Koryphaios Deck policy: on-screen questions (AskUserQuestion) are disabled in
> Deck-managed sessions because the operator answers from the Deck inbox or
> their phone. Ask the same question with the mcp__claude-peers__ask_operator
> tool (title, question, optional options); its return value is the operator
> answer.

### Ce que la doc officielle dit, pour mémoire

- La page Agent SDK `user-input` (callback `canUseTool`, `updatedInput.answers`)
  est SDK-only ; rien n'y vise une session `claude` interactive. Sa seule
  passerelle vers la CLI est la phrase sur `PermissionRequest`, déjà exploitée
  par `approval-hook.ts`.
- `PermissionRequest` tire « en mode d'approbation interactif seulement » :
  pas en `dontAsk`, `auto`, `bypassPermissions`. Ce que fait `AskUserQuestion`
  dans ces modes n'est ni documenté ni mesuré (point ouvert P3).
- `Notification` est informatif (aucune décision). `elicitation_dialog`
  concerne l'élicitation MCP (un serveur qui demande une saisie) ; claude-peers
  n'en émet pas. Rien à câbler de ce côté.

---

## 2. Structure actuelle : ce qui existe et sur quoi on construit

Le pipeline d'approbation est complet et n'est PAS à dupliquer :

- **Producteur déclaratif** : `ask_operator` / `ask_operator_wait`
  (`server.ts`, `handleAskOperator`). Lit le credential de session
  (`CLAUDE_PEERS_APPROVAL_FILE`, `shared/approval-client.ts`), poste
  `/approval/add` avec `kind: "question"`, `title`, `question`, `options[]`
  (≤ 10), `merge: "never"`, `reply_route: "channel"` si la session a une
  identité pair sinon `"pty"`, puis `/approval/wait` par tranches de 90 s avec
  ticket. La valeur de retour de l'outil EST la réponse (`answer_text`, ou
  « yes / approved » / « no / rejected »). Refuse avec un message clair quand
  le credential est absent (session antérieure à l'armement).
- **Producteur structurel** : `desktop/hooks/approval-hook.ts`, câblé sur
  `PermissionRequest` (matcher vide) et `Notification` (matcher vide,
  liste d'admission interne réduite à `agent_needs_input`). Poste sans
  attendre ; n'émet jamais de décision ; silencieux sans credential.
- **Gate** : le credential est armé inconditionnellement au démarrage du Deck
  (`approval-runtime.ts`, `env()` émet toujours la clé, vide quand désarmé) ;
  `mobileApprovals` ne gouverne que le relais téléphone (carte 7394e2f8). Donc
  « credential présent » ⇔ « `ask_operator` fonctionne dans cette session »,
  hôte ou sandbox (le broker est ponté dans le conteneur,
  `desktop/docs/sandbox.md`).
- **Consommateurs** : `pollPendingApprovals` → canal `approvals:pending` →
  `InboxPanel.tsx`. Pour un `kind: "question"`, `verdictAnswerKindFor`
  (`approval-verdict.ts`) relaie chaque chip d'option comme TEXTE (jamais
  allow/deny), plus un champ libre. Le mobile-shell et les passerelles
  Telegram / Discord / ntfy consomment la même ligne broker.
- **Dédoublonnage** : `tile_ref` identique ⇒ le second `/approval/add`
  retourne le premier (`ARCHITECTURE.md`, `tests/broker-approval-reply.test.ts`).
- **Plugin** : `desktop/deck-plugin/hooks/hooks.json`, hooks construits par
  `npm run build:hook` (`desktop/package.json`) en `.mjs`, chargés par
  `--plugin-dir` sur chaque tuile (`session-command.ts`), projetés (copiés)
  dans les sandboxes.
- **Précédent de refus `PreToolUse`** : `desktop/hooks/roadmap-guard-hook.ts`
  (`hookSpecificOutput.permissionDecision: "deny"` + `permissionDecisionReason`,
  fail-open, matcher nommé « never an empty matcher »).

Ce qui manque est UN producteur pour le cas `AskUserQuestion`, et un filet qui
empêche le producteur structurel de fabriquer un faux Allow/Deny.

---

## 3. Décision : refuser `AskUserQuestion` et rediriger vers `ask_operator`

### 3.1 Mécanisme retenu

Hook `PreToolUse`, matcher `AskUserQuestion`, nouveau fichier
`desktop/hooks/ask-operator-redirect-hook.ts` :

1. Gate : `loadApprovalCredential(process.env.CLAUDE_PEERS_APPROVAL_FILE)`.
   `null` ⇒ aucune sortie, exit 0 : le menu natif s'affiche, exactement comme
   aujourd'hui. C'est la MÊME condition que la disponibilité d'`ask_operator`
   (§2), donc la redirection ne peut pas viser un outil qui refuserait.
2. Payload avec `tool_name === "AskUserQuestion"` ⇒ sortie
   `permissionDecision: "deny"` avec la raison de M4.
3. Tout autre cas (autre outil, payload malformé, erreur interne) ⇒ aucune
   sortie, exit 0 (fail-open, comme `roadmap-guard-hook.ts`).

L'agent reçoit le refus comme un résultat d'outil, pose la même question via
`ask_operator` en reportant les labels dans `options` (M4), le broker route
vers le Courrier et le téléphone, la première réponse gagne, l'outil retourne
le texte. Zéro frappe, zéro dialogue, une entrée par question.

### 3.2 Pourquoi pas les alternatives

- **Le hook répond lui-même (M2, `updatedInput.answers`)** : il devrait BLOQUER
  jusqu'au verdict, sans rien afficher dans la tuile. Cela viole R1 de
  `docs/DESIGN-NOTIFY-EVENTS.md` (un état levé sans extincteur local visible),
  repose sur un comportement non documenté de la CLI, et ferait de la durée du
  hook la borne de l'attente (`blockSec`, 900 s par défaut) là où
  `ask_operator_wait` est reprenable indéfiniment par ticket.
- **Corriger seulement `PermissionRequest` (kind `question`, options =
  labels)** : la réponse doit alors être TAPÉE dans le menu Ink
  (`buildKeystrokes` ne connaît que Enter, Escape et texte + Enter) ; le
  mappage « texte tapé sur un chooser numéroté » n'est pas mesuré, et
  `multiSelect` n'a aucune traduction clavier sûre. Gardé comme FILET, pas
  comme producteur (§3.3).
- **Guider par le prompt seulement** (description de l'outil, system prompt) :
  la description d'`ask_operator` dit déjà « use it instead of an on-screen
  question when they may be away » et l'agent a quand même appelé
  `AskUserQuestion` dans les quatre runs. Un hook est déterministe, un conseil
  ne l'est pas.

### 3.3 Filet : `approval-hook.ts` ne fabrique plus de faux Allow/Deny

`classifyPayload` retourne `skip` pour un `PermissionRequest` dont
`tool_name === "AskUserQuestion"`. Justification : soit le hook de redirection
a refusé l'appel (et `PermissionRequest` ne tire pas, M4), soit il a échoué
(bug, timeout) et le menu natif est à l'écran : l'`AttentionDetector`
(`❯ 1.`) lève alors le badge local et l'approbation de repli, comme pour tout
écran d'attente non couvert. Un item Allow/Deny pour un menu à choix serait
une réponse fausse par construction, et une réponse fausse coûte plus qu'une
notification manquante (asymétrie déjà ratifiée, carte 47baf25a).

Précision d'énoncé : ce filet ne couvre que `PermissionRequest`. Le cas
`Notification/permission_prompt` est déjà `skip`.

### 3.4 Ce qui NE change pas

Aucune route broker, aucune table, aucun canal IPC, aucun composant renderer,
aucune chaîne i18n : l'item qui arrive dans le Courrier est un `ask_operator`
ordinaire, déjà rendu avec chips d'options et champ libre. Le mobile-shell et
les passerelles ne voient rien de nouveau.

---

## 4. Plan d'implémentation par lot

Chaque lot est un commit, ordre imposé. La carte roadmap est créée AVANT le
premier commit (via `roadmap_add` ou le Deck), son id8 va sur la première ligne
du CORPS de chaque commit (`Card <id8>.`). Test ciblé par lot ; le gate complet
(`bun test`, smoke build, typecheck desktop) une seule fois, avant la séquence
de commits, par celui qui committe (`desktop-precommit`).

### Lot 0 : la sonde, versionnée, pour ne plus supposer

Fichier `scripts/probe-askuserquestion-hooks.py` (annexe A, nettoyée) +
paragraphe dans `TESTING.md`, section « Cross-platform tests » ou voisine :
« Sondes hors gate » — comment la lancer, ce qu'elle imprime, quand la rejouer
(chaque bump de CLI dans le Deck, toute modification de `hooks.json`).

Pourquoi Python et pas Bun : Bun n'a pas de pty ; `node-pty` n'est disponible
que dans `desktop/`. `python3` + module `pty` de la bibliothèque standard est
le plus petit outil qui fonctionne sur Linux et macOS (Windows : hors périmètre
de la sonde, noté dans son en-tête).

La sonde n'entre PAS dans `bun test` : elle lance une vraie CLI authentifiée
et un vrai modèle. Elle n'est pas un test, c'est un instrument de mesure.

Sortie attendue documentée : la table M1 et, en mode `--redirect`, la ligne
`MCP-call {"name": "ask_operator", ...}` puis `ANSWER=Beta`.

### Lot 1 : le hook de redirection

**`desktop/hooks/ask-operator-redirect-hook.ts`** (nouveau)

- En-tête : ce que le hook décide (refus + redirection), pourquoi un hook et
  non un conseil (M4 vs les quatre runs), pourquoi le gate est le credential
  (⇔ `ask_operator` disponible), fail-open. Pas d'historique, pas de date, pas
  de `see <file>`.
- `export const ASK_USER_QUESTION_TOOL = "AskUserQuestion"`.
- `export const REDIRECT_REASON` : le texte de M4. Le nom d'outil y est
  `mcp__claude-peers__ask_operator` : c'est le nom sous lequel `README.md`
  fait installer le serveur (`claude mcp add ... claude-peers`). Point ouvert
  P1 sur l'alias.
- `export function parseHookPayload(raw): HookPayload` — même contrat que les
  deux autres hooks (malformé ⇒ `{}`).
- `export function buildDecision(payload, cred): Decision | null` — pure :
  `null` si `cred` est `null`, `null` si `tool_name !== ASK_USER_QUESTION_TOOL`,
  sinon `{ hookSpecificOutput: { hookEventName: "PreToolUse",
  permissionDecision: "deny", permissionDecisionReason: REDIRECT_REASON } }`.
  Aucun autre champ (`updatedInput`, `additionalContext`) : le hook ne modifie
  rien.
- `main()` : lit stdin, `loadApprovalCredential(process.env[APPROVAL_FILE_ENV])`,
  écrit la décision sur stdout si non nulle, exit 0. `try/catch` global
  fail-open avec `process.exit(0)`, comme `roadmap-guard-hook.ts`. Pas de
  trace possible ici (aucun puits de log n'est joignable depuis un hook, même
  règle que les deux hooks existants) : c'est le lot 4 qui rend l'échec
  visible.

**`desktop/deck-plugin/hooks/hooks.json`** : entrée `PreToolUse` supplémentaire,
matcher `AskUserQuestion`, commande
`bun "${CLAUDE_PLUGIN_ROOT}/hooks/ask-operator-redirect-hook.mjs"`, timeout 10.
Matcher NOMMÉ, jamais vide (un matcher vide lancerait un processus à chaque
appel d'outil).

**`desktop/package.json`**, script `build:hook` : ajouter la quatrième
compilation `bun build hooks/ask-operator-redirect-hook.ts --target=node
--outfile=deck-plugin/hooks/ask-operator-redirect-hook.mjs`.

**`tests/roadmap-guard-hook.test.ts`**, test « hooks.json's PreToolUse matcher
set equals the .ts source's TOOL_TEXT_FIELDS key set » : il compare TOUS les
matchers `PreToolUse` aux clés de `TOOL_TEXT_FIELDS` et cassera. Restreindre le
côté `hooks.json` aux entrées dont la commande contient
`roadmap-guard-hook.mjs` (filtre sur `hooks[].command`), et garder l'égalité
stricte sur ce sous-ensemble. Ne PAS élargir `TOOL_TEXT_FIELDS`.

**`tests/ask-operator-redirect-hook.test.ts`** (nouveau), calqué sur
`tests/approval-hook.test.ts` :

- Purs : `buildDecision` ⇒ `null` sans credential même pour `AskUserQuestion`
  (message d'assertion : « without a credential the native menu must stay
  up ») ; `null` pour `Bash` avec credential ; refus pour `AskUserQuestion`
  avec credential ; la raison contient `mcp__claude-peers__ask_operator` ET
  les mots `title`, `question`, `options` (ce sont les trois arguments que
  l'agent doit reporter, M4) ; payload malformé ⇒ `null`.
- Sous-processus (`Bun.spawn(["bun", "desktop/hooks/ask-operator-redirect-hook.ts"])`) :
  sans `CLAUDE_PEERS_APPROVAL_FILE` ⇒ stdout vide, exit 0 ; avec un credential
  complet écrit en 0600 ⇒ stdout est un JSON dont
  `hookSpecificOutput.permissionDecision === "deny"` ; avec un credential
  INCOMPLET (sans `privateKey`) ⇒ stdout vide (le gate est celui de
  `loadApprovalCredential`, pas une simple existence de fichier) ; stdin
  `not json` ⇒ stdout vide, exit 0.
- Couverture, pas seulement sensibilité : un test qui affirme que la sortie ne
  contient AUCUNE clé autre que `hookSpecificOutput` avec exactement
  `hookEventName`, `permissionDecision`, `permissionDecisionReason` — un
  `updatedInput` ajouté par erreur changerait la sémantique (M2) sans faire
  rougir un test de sensibilité.
- Cohérence plugin : `hooks.json` a exactement UNE entrée `PreToolUse` de
  matcher `AskUserQuestion`, dont la commande nomme
  `ask-operator-redirect-hook.mjs`, et `package.json`'s `build:hook` compile
  ce fichier (même esprit que `desktop-deck-plugin-agent-refs.test.ts` : le
  nom est load-bearing).

Commande à rapporter : `bun test tests/ask-operator-redirect-hook.test.ts
tests/roadmap-guard-hook.test.ts`.

### Lot 2 : le filet dans `approval-hook.ts`

- `classifyPayload` : `PermissionRequest` avec
  `tool_name === "AskUserQuestion"` ⇒ `skip`. Commentaire de deux lignes :
  un menu à choix n'a pas de verdict Allow/Deny ; le hook de redirection est
  le producteur, l'`AttentionDetector` le repli.
- En-tête du fichier : remplacer « Wired only on PermissionRequest and
  Notification's agent_needs_input » par la liste réelle, sans narration.
- `tests/approval-hook.test.ts` : test pur « an AskUserQuestion permission
  request is skipped — a chooser has no allow/deny verdict », et test
  sous-processus « an AskUserQuestion PermissionRequest registers nothing »
  (même forme que « an idle_prompt notification registers nothing »). Vérifier
  que `buildApprovalRequest` n'est plus atteignable pour ce cas : le test
  sous-processus liste `/approval/list` et attend zéro ligne après le délai
  du hook.

Commande : `bun test tests/approval-hook.test.ts`.

### Lot 3 : documentation qui contredit la mesure

- `DESKTOP.md`, paragraphe « Remote approvals » : remplacer « no hook covers
  `AskUserQuestion` or plan approval » par la description à trois producteurs
  + redirection : `PermissionRequest` (permissions d'outil), `PreToolUse`
  `AskUserQuestion` → refus + `ask_operator` (questions à choix), `ask_operator`
  (questions libres de l'agent), `attention.ts` en repli. Une phrase sur le
  filet. Rester factuel, pas de « previously ».
- `docs/DESIGN-NOTIFY-EVENTS.md`, lignes U2' (deux occurrences, tableau des
  points ouverts et tableau récapitulatif) : « menu `AskUserQuestion` :
  MESURÉ 2026-09-06, tire `PreToolUse` + `PermissionRequest` +
  `Notification/permission_prompt`, pas `agent_needs_input` ; traité par
  redirection, voir `DESIGN-ASKUSERQUESTION-REDIRECT.md` ». Le brief a le
  droit de citer un brief ; le code, non.
- `ARCHITECTURE.md`, « De-duplication » : la phrase « the hook's
  `agent_needs_input` and the Deck's attention detector both fire on the same
  screen » reste vraie pour les écrans de permission ; ajouter que le cas
  `AskUserQuestion` ne passe plus par là.
- `BACKLOG.md`, §3.1 bis « Approbations distantes » : ajouter les points
  ouverts P1..P4 (§5) sous une sous-section « AskUserQuestion → Courrier ».

### Lot 4 : visibilité de l'échec du hook (R1)

Le hook ne peut pas journaliser. Le seul signal disponible côté Deck quand la
redirection a échoué est l'`AttentionDetector` qui voit `❯ 1.` alors que la
session porte un credential. Ajouter, dans le handler `service.on('attention')`
de `desktop/src/main/index.ts`, une ligne `journal.add('attention', ...)`
quand `waiting: true` ET `approvals.env().CLAUDE_PEERS_APPROVAL_FILE !== ''` ET
le dernier écran contient le corps d'un `AskUserQuestion` — si et seulement si
un corps distinctif existe. Point ouvert P2 : la mesure M1 n'a pas capturé le
corps OSC ; l'écran mesuré porte « Enter to select · ↑/↓ to navigate · Esc to
cancel », commun aux trois choosers. Sans corps distinctif, ce lot se réduit à
un test qui affirme que le badge local se lève toujours pour ce cas (couvert
par `tests/desktop-attention.test.ts` existant, à vérifier), et P2 reste
ouvert. Ne PAS inventer un motif textuel de plus (ils pourrissent en silence,
`DESIGN-NOTIFY-EVENTS.md` §1).

### Lot 5 : validation terrain (hors CI, checklist `BACKLOG.md` §2 ou §3.1 bis)

- [ ] Tuile Deck, `mobileApprovals` OFF : un `AskUserQuestion` produit une
      entrée Courrier avec chips d'options ; répondre par chip → l'agent
      continue avec ce texte ; répondre en texte libre → idem.
- [ ] `mobileApprovals` ON, ntfy enrôlé : la même question arrive sur le
      téléphone avec ses boutons ; répondre depuis le téléphone → le Courrier
      passe « traité via ... », l'agent continue.
- [ ] Question à `multiSelect: true` : l'agent reporte les labels dans
      `options` ; la réponse libre « A, C » est acceptée par l'agent.
- [ ] Deux questions dans un seul `AskUserQuestion` : l'agent fait deux
      `ask_operator` successifs (ou un seul combiné) ; l'opérateur reçoit
      chaque question.
- [ ] Sandbox Docker : même comportement (le plugin est projeté, le broker
      ponté).
- [ ] Session lancée AVANT l'armement du credential (Deck redémarré avec des
      tuiles restaurées) : menu natif, pas de refus, pas d'item Allow/Deny.
- [ ] Session `claude` hors Deck (terminal) : rien ne change.
- [ ] Superviseur (Home rail) : la redirection s'applique aussi ; vérifier que
      son prompt système n'attend pas un menu natif.

---

## 5. Points ouverts, nommés

| # | Point | Impact | Qui |
|---|---|---|---|
| P1 | **Alias du serveur MCP.** La raison cite `mcp__claude-peers__ask_operator`. Un opérateur qui a installé le serveur sous un autre nom (`claude mcp add ... <autre>`) obtient M3 : l'agent refuse la redirection comme injection. Piste : le Deck connaît-il le nom sous lequel il a enregistré le serveur ? Si oui, le passer au hook par le fichier credential (champ `mcpServerName`) et composer la raison ; sinon, formuler la raison avec « the claude-peers MCP tool `ask_operator` » et mesurer (nouvelle sonde) que l'agent le retrouve sans le préfixe. | Redirection inerte chez un opérateur sur deux si l'alias diffère | debugger, sonde |
| P2 | **Corps distinctif d'un `AskUserQuestion` à l'écran** pour le lot 4. Non mesuré (la sonde capture le pty, pas l'OSC 777). | Sans lui, l'échec du hook n'est visible que par le badge générique | debugger |
| P3 | **Modes `bypassPermissions` / `dontAsk` / `auto`** : `PermissionRequest` n'y tire pas (doc) ; `PreToolUse` y tire-t-il ? Le menu natif s'affiche-t-il ? Non mesuré. Les tuiles du Deck qui tournent en `--dangerously-skip-permissions` sont concernées. | La redirection peut être inerte précisément là où l'opérateur regarde le moins | sonde, un run par mode |
| P4 | **Dérive CLI.** M1..M4 valent pour 2.1.261. Rejouer la sonde à chaque bump de la CLI embarquée / recommandée par le Deck. | Le hook devient inerte ou faux sans test rouge | mainteneur, lot 0 |
| P5 | **Sous-agents.** `AskUserQuestion` n'est pas disponible dans les sous-agents (doc SDK) ; `ask_operator` l'est-il (le credential est hérité par l'environnement) ? Non mesuré, faible enjeu. | — | — |

---

## Annexe A : recette de la sonde (Linux/macOS)

```python
# probe-askuserquestion-hooks.py -- run an interactive claude in a pty and log
# which hooks fire on an AskUserQuestion. Usage: python3 probe.py [--redirect]
# Needs: claude on PATH, an authenticated environment, python3 >= 3.8.
import os, pty, re, select, sys, time, json
S = os.path.abspath(os.path.dirname(__file__)) + "/probe-work"
os.makedirs(S + "/proj/.claude", exist_ok=True); os.makedirs(S + "/home", exist_ok=True)
LOG = S + "/hooks.log"; open(LOG, "w").close()
# Onboarding + trust pre-seeded so no chooser precedes the question.
open(S + "/home/.claude.json", "w").write(json.dumps({"theme": "dark",
    "hasCompletedOnboarding": True, "projects": {S + "/proj": {"hasTrustDialogAccepted": True}}}))
open(S + "/hooklog.sh", "w").write('#!/bin/bash\nprintf "%s %s\\n" "$1" "$(cat)" >> "$PROBE_LOG"\n')
os.chmod(S + "/hooklog.sh", 0o755)
redirect = "--redirect" in sys.argv
pre = S + "/hooklog.sh PreToolUse"
if redirect:
    reason = ("Koryphaios Deck policy: on-screen questions (AskUserQuestion) are disabled in "
              "Deck-managed sessions because the operator answers from the Deck inbox or their "
              "phone. Ask the same question with the mcp__claude-peers__ask_operator tool "
              "(title, question, optional options); its return value is the operator answer.")
    open(S + "/deny.sh", "w").write('#!/bin/bash\nIN="$(cat)"; printf "PreToolUse-deny %s\\n" "$IN" >> "$PROBE_LOG"\n'
        + "printf '%s' " + repr(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse",
          "permissionDecision": "deny", "permissionDecisionReason": reason}})) + "\n")
    os.chmod(S + "/deny.sh", 0o755); pre = S + "/deny.sh"
    # Minimal stdio MCP server: one tool, ask_operator, answers "Beta".
    open(S + "/fake-mcp.py", "w").write(r'''
import sys, json, os
log = open(os.environ["PROBE_LOG"], "a")
def send(o): sys.stdout.write(json.dumps(o) + "\n"); sys.stdout.flush()
for line in sys.stdin:
    if not line.strip(): continue
    m = json.loads(line); mid = m.get("id"); meth = m.get("method")
    if meth == "initialize":
        send({"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": m["params"].get("protocolVersion", "2024-11-05"),
              "capabilities": {"tools": {}}, "serverInfo": {"name": "claude-peers", "version": "0"}}})
    elif meth == "tools/list":
        send({"jsonrpc": "2.0", "id": mid, "result": {"tools": [{"name": "ask_operator",
          "description": "Ask the HUMAN operator a blocking question and WAIT for the answer.",
          "inputSchema": {"type": "object", "properties": {"title": {"type": "string"}, "question": {"type": "string"},
            "options": {"type": "array", "items": {"type": "string"}}}, "required": ["title", "question"]}}]}})
    elif meth == "tools/call":
        log.write("MCP-call " + json.dumps(m["params"]) + "\n"); log.flush()
        send({"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": "Beta"}]}})
    elif mid is not None:
        send({"jsonrpc": "2.0", "id": mid, "result": {}})
''')
    open(S + "/mcp.json", "w").write(json.dumps({"mcpServers": {"claude-peers": {"command": "python3",
        "args": [S + "/fake-mcp.py"], "env": {"PROBE_LOG": LOG}}}}))
hooks = {"hooks": {
    "PermissionRequest": [{"matcher": "", "hooks": [{"type": "command", "command": S + "/hooklog.sh PermissionRequest", "timeout": 5}]}],
    "Notification": [{"matcher": "", "hooks": [{"type": "command", "command": S + "/hooklog.sh Notification", "timeout": 5}]}],
    "PreToolUse": [{"matcher": "AskUserQuestion", "hooks": [{"type": "command", "command": pre, "timeout": 10}]}],
    "PostToolUse": [{"matcher": "AskUserQuestion", "hooks": [{"type": "command", "command": S + "/hooklog.sh PostToolUse", "timeout": 5}]}]}}
open(S + "/proj/.claude/settings.json", "w").write(json.dumps(hooks))
env = dict(os.environ); env.update({"PROBE_LOG": LOG, "HOME": S + "/home", "TERM": "xterm-256color"})
for k in ("CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION"): env.pop(k, None)
prompt = ("Use the AskUserQuestion tool to ask me a single question: do I prefer option Alpha or option Beta? "
          + ("When you have my answer, reply with exactly one line ANSWER=<answer> and stop." if redirect else "Do nothing else."))
argv = ["claude", "--permission-mode", "default"]
if redirect:  # NOTE: --allowedTools is variadic, keep the '=' form or it swallows the prompt
    argv += ["--mcp-config", S + "/mcp.json", "--strict-mcp-config", "--allowedTools=mcp__claude-peers__ask_operator"]
argv.append(prompt)
pid, fd = pty.fork()
if pid == 0:
    os.chdir(S + "/proj"); os.execvpe("claude", argv, env)
t0 = time.time(); buf = b""; seen = None
strip = lambda b: re.sub(rb"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]", b"", b)
while time.time() - t0 < 170:
    r, _, _ = select.select([fd], [], [], 1)
    if r:
        try: d = os.read(fd, 65536)
        except OSError: break
        if not d: break
        buf += d
    s = strip(buf[-6000:])
    if redirect and b"ANSWER=" in s and time.time() - t0 > 15: time.sleep(6); break
    if not redirect and b"Alpha" in s and b"Beta" in s and seen is None: seen = time.time()
    if seen and time.time() - seen > 75: break  # long enough for the 60 s notification class
os.kill(pid, 9)
for line in open(LOG):
    tag, _, js = line.partition(" ")
    try: d = json.loads(js)
    except ValueError: print(tag, js[:300]); continue
    for k in ("session_id", "transcript_path", "cwd", "scratchpad_dir", "prompt_id"): d.pop(k, None)
    print(tag, json.dumps(d)[:700])
```

Résultats attendus sur 2.1.261 : sans `--redirect`, trois lignes `PreToolUse`,
`PermissionRequest`, `Notification` (`permission_prompt`) et aucune
`agent_needs_input` ; avec `--redirect`, `PreToolUse-deny`, `MCP-call
{"name": "ask_operator", ...}` et `ANSWER=Beta` à l'écran.
