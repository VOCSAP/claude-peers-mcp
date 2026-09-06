# Federation peers/messages : la replica relaie ses agents vers l'upstream

## Statut

Brief ecrit le 2026-09-06, avant implementation, pour lever la limite v1 du
mode `replica` (`docs/DESIGN-OFFLINE-REPLICA.md` §2.2 et §10, `BACKLOG.md`
§3.9 item n°1) : en mode replica les tables `peers` et `messages` sont locales
a chaque broker, donc la messagerie inter-machines est coupee MEME EN LIGNE.
Les arbitrages ouverts sont en §11 ; ils sont a trancher AVANT le code.

Etiquettes : **MESURE** (commande executee, sortie citee), **DEDUIT** (lu dans
le code, `file:line`), **DECIDE** (arbitrage propose ici, a confirmer par
l'operateur en §11 quand il est marque « a confirmer »).

---

## 1. Le besoin et ce que le code fait aujourd'hui

Attendu : quand la replica est en ligne, les agents des differentes machines
se voient (`list_peers`) et s'ecrivent (`send_message`, operateur inclus)
comme en mode `remote`, via l'upstream. Hors ligne, la messagerie locale
continue sans interruption ; a la reconnexion rien n'est perdu cote local et
les messages inter-machines emis pendant la coupure ont un sort explicite.

**DEDUIT** (`shared/config.ts:279-291`) -- en mode `replica`, `brokerUrl()`
renvoie loopback : `server.ts`, le Deck et `cli.ts` ne parlent qu'au broker
local. Option A du brief replica (§2) : les clients ne changent jamais de
broker, c'est le broker local qui relaie. Ce brief ne touche AUCUN transport
client.

**DEDUIT** (`broker.ts:462-479`, `:514-525`) -- `peers` est cle par
`instance_token` (UUID v4 mint par `randomUUID()` dans `handleRegister`,
`broker.ts:1995` et `:2047`), `UNIQUE (peer_id, group_id)` ; `messages` porte
deux FK `NOT NULL` vers `peers(instance_token)` (`from_token`, `to_token`).
Il n'existe AUCUNE cle Ed25519 par peer : les deux tables `public_key`
(`broker.ts:1098`, `:1112`) sont `approval_operators` et
`approval_session_tokens`, l'identite OPERATEUR des approbations. L'enonce
« identite Ed25519 des peers deja compatible avec un re-enregistrement sur
un autre broker » (`BACKLOG.md` §3.9) est donc FAUX pour les peers : un peer
n'a pas d'identite portable, seulement un token de routage local a son
broker. Consequence structurante (§2.1) : la replica doit presenter a
l'upstream une reference qui n'est PAS ce token.

**DEDUIT** (`broker.ts:2193-2258`) -- `handleListPeers` filtre
`status = 'active'` dans le groupe de l'appelant, puis par `cwd` /
`project_key` / `git_root` selon `scope`, exclut l'appelant, et projette par
`toPublicPeer`. **DEDUIT** (`broker.ts:2167-2170`) -- `toPublicPeer` est un
rest-spread qui retire trois champs (`instance_token`, `pid`, `client_pid`)
et laisse passer tout le reste : la forme canonique « echoue OUVERT » de
`TESTING.md`. Toute colonne ajoutee a `peers` par ce lot serait publiee sans
qu'un test echoue.

**DEDUIT** (`broker.ts:2260-2346`) -- `handleSendMessage` resout l'expediteur
par `from_token`, le destinataire par `(peer_id, group_id, status='active')`
(`:2303-2308`), insere via `recordMessageTx` (`:1768-1777` : insertion,
`last_activity_at` des deux cotes, puis `ackPriorMessagesForSender` qui marque
livres tous les messages non livres ADRESSES a l'expediteur -- mecanique A de
`ARCHITECTURE.md`), puis pousse en WS si le destinataire est dans `wsPool`
(`:2324-2342`), sans jamais marquer livre. `operator` est route vers le
sentinel `__operator__` du groupe de l'expediteur, refuse dans le groupe
`default` (`:2282-2301`).

**DEDUIT** (`broker.ts:1371-1384`) -- `cleanStalePeers` sonde `process.kill
(pid, 0)` pour les peers actifs dont `host = hostname()` du broker : un peer
distant portant le MEME hostname (deux comptes OS d'une meme machine, ou deux
machines homonymes) serait sonde contre un PID qui n'est pas le sien. Le
brief replica (§5) a le meme piege pour les verrous ; ici il faut EXCLURE
explicitement toute ligne relayee ou miroir de cette sonde, pas se reposer
sur `host`.

**DEDUIT** (`broker.ts:1417-1423`) -- `sweepInactivePeers` bascule dormant
tout actif dont `last_seen` a plus de `ACTIVE_STALE_SEC` (120 s), toutes
origines confondues : c'est LE mecanisme existant par lequel une replica
muette doit voir ses peers passer dormants en amont, a condition que le
relais ecrive `last_seen` a chaque passage.

**DEDUIT** (`broker.ts:4489-4540`) -- les trois gardes de role existent deja
et interpolent le nom de la route dans leur message : `refuseWhenReplica`
(403, une replica ne sert jamais l'upstream), `requireServeReplicas` (403,
role explicite), `requireBrokerToken` (403, credential). `REPLICA_ID_REGEX`
(`:4445`) valide la FORME du `replica_id` ; `ensureReplicaId` (`:5369`) le
persiste dans `roadmap_sync_meta`. `upstreamPost` (`:5405`) porte le Bearer
et un timeout de 10 s. `runSyncPass` (`:5898-5945`) enchaine pull, push,
verrous, publie UN instantane `syncPublished` en `finally`, et re-arme
`armSyncTimer` ; l'hysteresis online/offline y vit.

**DEDUIT** (`server.ts:2408-2414`) -- heartbeat client toutes les 15 s,
corps `{ instance_token }`. `formatPeer` (`server.ts:992-1003`) rend
`peer_id (host)`, `CWD`, puis `Role`/`Repo`/`Project`/`TTY`/`Summary` s'ils
existent et `Last exchange`. Aucun champ d'origine n'existe.

**DEDUIT** (`desktop/src/main/broker-client.ts:1-2`, grep `list-peers` dans
`desktop/` : aucun resultat) -- le Deck n'est pas un peer et ne liste jamais
les peers : il n'appelle que `/announce`, `/operator-inbox`, les routes
roadmap/approbations/drafts/dispatch. Le mapping tuile -> peer passe par le
fichier de cache `peer-id-<cwd>-<session>.txt` (`peer-state.ts:50-86`),
jamais par le broker. Le perimetre Deck de ce lot est donc REDUIT : aucune
liste de peers a marquer, seulement les annonces (§2.5) et, en option,
des compteurs (§9).

**MESURE** (`tests/broker-roadmap-replica.test.ts:58-71`, `:134-148`) -- le
harnais a deux brokers existe : un proxy `Bun.serve` entre replica et
upstream, bascule `upstreamBlocked` pour simuler la coupure, `goOffline()` /
`goOnline()` attendent `status.online`. Un troisieme broker n'est qu'un
`startBroker(env)` de plus.

---

## 2. Modele : le broker local relaie ses agents sous `replica_id`

**DECIDE** -- Option A conservee : le broker replica devient, aupres de
l'upstream, un CLIENT qui porte ses peers. Il s'identifie par son
`replica_id` (deja persiste) et s'authentifie par `broker_token`. Deux routes
upstream suffisent, une par sens de responsabilite :

| Route | Qui appelle | Role |
|---|---|---|
| `POST /federation/sync` | la replica, a chaque passage | pousse la LISTE de ses peers actifs (= enregistrement + heartbeat + deconnexion en un seul message), recoit l'annuaire des peers distants, les messages entrants et l'inbox operateur, acquitte le lot precedent |
| `POST /federation/send` | la replica, SYNCHRONE, depuis `handleSendMessage` / `handleAnnounce` | relaie un message d'un de ses peers (ou de son Deck) vers un peer distant ou l'operateur |

Les deux sont gardees par les trois gardes existantes (§7). Aucune autre
route ne change de contrat ; `/register`, `/heartbeat`, `/send-message`,
`/list-peers`, `/ws` restent byte-identiques pour les clients.

### 2.1 Identites qui traversent la frontiere

**DECIDE** -- un `instance_token` ne traverse jamais, dans aucun sens. La
replica designe chacun de ses peers par un `relay_ref` =
`sha256(instance_token)` hex tronque a 32 caracteres : deterministe (aucune
table d'etat, aucune course entre deux passages), non inversible (le token
est un UUID v4, 122 bits d'entropie), et STABLE tant que le peer garde son
token -- donc a travers un `resume` (`ARCHITECTURE.md` « Resume flow »
reutilise le meme token). L'upstream cle la ligne relayee par
`(relay_id, relay_ref)`, unique ; deux replicas ne peuvent pas se marcher
dessus, et une meme replica ne peut pas creer deux lignes pour un peer.

**DECIDE** -- l'upstream mint son PROPRE `instance_token` interne pour la
ligne relayee (il en faut un : FK `messages`, cle `wsPool`, cle
`SELECT ... WHERE instance_token`) et ne le renvoie JAMAIS a la replica. La
replica adresse toujours par `(replica_id, relay_ref)` ; l'upstream resout
l'OBJET (sa ligne) puis verifie que l'appelant est bien le relais de cette
ligne (`relay_id = replica_id`), jamais « a qui appartient cet appelant ».

**DECIDE** -- le nom affiche. Le `peer_id` local est propose tel quel a
l'upstream ; s'il est pris dans le groupe (par un peer natif, un peer d'une
autre replica, ou un nom reserve), l'upstream le suffixe comme
`deriveDefaultId` (`-2`, `-3`, ...) et renvoie le nom retenu dans
`assigned`. La replica le persiste dans `upstream_peer_id` sur SA ligne
locale et l'expose dans `list_peers` (`Federated as: <nom>`) ; le nom local
ne change pas (un `set_id` sous les pieds d'un agent est pire qu'un alias).
Un `set_id` local repart au passage suivant et l'upstream renomme la ligne
relayee si le nouveau nom est libre. L'affectation est COLLANTE : tant que la
replica propose le meme nom, la ligne garde le sien. (**a confirmer**, §11
Q5 : l'alternative est de refuser le relais du peer en collision.)

### 2.2 Ce que l'upstream fait d'un peer relaye

Une ligne ORDINAIRE de `peers`, avec `relay_id`/`relay_ref` remplis et
`via = <replica8>` (8 premiers caracteres du `replica_id`, comme le prefixe
`via:` des auteurs roadmap ; etiquette d'affichage, jamais une cle) :

- `pid = 0`, `client_pid = 0`, `claude_cli_pid = NULL`, `tty = NULL` : la
  replica ne transmet aucun PID (entree hostile n°2 de `CLAUDE.md`).
- `host`, `cwd`, `git_root`, `project_key`, `summary`, `role`,
  `last_activity_at` : copies du dernier passage, donc `list_peers` d'un
  agent natif upstream la trouve dans les scopes `machine`/`directory`/`repo`
  exactement comme un peer distant en mode `remote`.
- `last_seen = now` a chaque passage ou elle figure -> `sweepInactivePeers`
  la bascule dormante 120 s + un tick apres que la replica s'est tue : la
  vivacite demandee, par le mecanisme existant (§6).
- Absente de la liste d'un passage alors qu'elle etait relayee par CE
  `replica_id` -> dormante IMMEDIATEMENT (c'est ainsi que `/disconnect`
  local, le sweep local et la mort d'un PID local se propagent, sans route
  dediee).
- Aucune ligne `peer_sessions` : le resume est une affaire locale a la
  replica. Un `/register` natif upstream sur le meme `(host, cwd, group)`
  ne trouve donc rien a reprendre et mint un nouveau nom, que
  `deriveDefaultId` choisit hors du nom relaye (UNIQUE par construction).
- `cleanStalePeers` phase 1 EXCLUT `relay_id IS NOT NULL` de la sonde PID
  (voir §1 : `host` ne suffit pas). Phase 2 (purge dormant > 24 h) la traite
  comme n'importe quelle ligne ; une replica qui revient la recree.
- **DECIDE** -- `ackPriorMessagesForSender` (mecanique A) NE s'applique PAS
  aux messages adresses a une ligne relayee : « si X repond, X a traite ses
  messages precedents » est vrai pour un client qui lit son propre broker,
  faux pour un peer dont les messages attendent encore d'etre tires par sa
  replica. Sans cette exemption, le premier message qu'un agent replica
  envoie a un peer natif ferait disparaitre, marques livres, tous ceux qui
  l'attendaient upstream. Un test le pose en rouge d'abord.
- `handleSendMessage` upstream (natif -> relaye) ne change PAS : la ligne
  relayee est active, le message est insere `delivered = 0`, `wsPool` n'a
  pas d'entree, il attend le prochain `/federation/sync` de sa replica.

### 2.3 Ce que la replica fait des peers distants : lignes miroir

**DECIDE** -- les peers distants recus dans la reponse de `/federation/sync`
sont ecrits dans la table `peers` LOCALE comme lignes miroir, pas dans une
table a part : `handleListPeers`, `handleSendMessage` (resolution de cible),
`handleAnnounce` (diffusion), `deriveDefaultId` et `set_id` (unicite des
noms) les voient alors sans qu'aucune requete ne change. Une ligne miroir :

- `instance_token` mint LOCALEMENT (`randomUUID()`), jamais expose, jamais
  accepte par une route cliente (aucun client ne le connait) ;
- `via` = valeur recue (`'upstream'` pour un peer natif de l'upstream,
  `<replica8>` pour le peer d'une autre replica, tel que l'upstream le
  transmet) ; `upstream_peer_id` = son nom upstream, qui est aussi son
  `peer_id` local sauf collision (ci-dessous) ;
- clee par `(group_id, upstream_peer_id)` avec `via IS NOT NULL` -- l'unicite
  `(peer_id, group_id)` upstream garantit qu'il n'y a jamais deux objets
  derriere ; un renommage upstream (`set_id` distant) apparait comme un
  miroir qui disparait (dormant) et un autre qui nait ;
- `pid = 0`, `client_pid = 0` ; `host`, `cwd`, `git_root`, `project_key`,
  `summary`, `role`, `last_activity_at`, `status` copies ; `last_seen = now`
  du passage ;
- non recue dans un passage -> dormante ; a la bascule OFFLINE (hysteresis
  de `runSyncPass`) -> TOUTES dormantes immediatement, sans attendre les
  120 s du sweep : hors ligne, un agent local ne doit pas voir un peer
  distant comme joignable ;
- `cleanStalePeers` phase 1 EXCLUT `via IS NOT NULL` ; phase 2 les purge
  comme les autres (recreees au prochain passage) ;
- collision avec une ligne LOCALE de meme `peer_id` (peer local enregistre
  hors ligne pendant qu'un homonyme existait upstream) : le miroir est
  insere sous un nom suffixe (`deriveDefaultId` sur le nom upstream), son
  `upstream_peer_id` garde le vrai nom, et un avertissement est journalise
  une fois par nom. Le relais traduit toujours vers `upstream_peer_id`,
  jamais vers le `peer_id` local du miroir ;
- l'upstream n'envoie JAMAIS a une replica ses propres peers relayes
  (`relay_id <> replica_id` dans la projection) : un agent local ne se voit
  pas en double sous son alias upstream.

`list_peers` d'un agent local rend donc, dans ses scopes habituels, les
peers locaux (`via` absent) ET les peers distants actifs (`via` present),
avec leur `host`/`cwd` reels. `formatPeer` (`server.ts`) ajoute une ligne
`Via: upstream` / `Via: replica <8>` quand `via` est present, et
`Federated as: <nom>` sur un peer local dont l'alias upstream differe.

### 2.4 Messages

**Sortant (agent local -> peer distant)** -- **DECIDE** : relais SYNCHRONE.
`handleSendMessage` local resout la cible dans `peers` ; si `via IS NOT
NULL`, il appelle `POST /federation/send { replica_id, from_ref, to_peer_id:
<upstream_peer_id>, text }` et renvoie la reponse `{ ok, error? }` de
l'upstream telle quelle a l'agent. Aucune ligne `messages` locale n'est
ecrite (la table est une file de livraison, pas un historique) ; le
`last_activity_at` de l'expediteur et la mecanique A LOCALE s'appliquent
(l'expediteur a bien traite ce que SON broker lui avait remis). Cote
upstream, `/federation/send` resout l'expediteur = ligne
`(relay_id = replica_id, relay_ref = from_ref)`, refuse 404 sinon, puis
reutilise `handleSendMessage` avec le token INTERNE de cette ligne : le
destinataire natif recoit en WS, un destinataire relaye par une autre
replica attend son passage, `operator` tombe dans l'inbox upstream du groupe
(§2.5). Un echec reseau ou un 5xx rend `{ ok: false, error: "peer 'X' is on
another machine and the upstream broker did not answer" }` a l'agent --
immediat, explicite, aucune file (§5).

**Entrant (peer distant -> agent local)** -- tire par `/federation/sync` :
la reponse porte les lignes `messages` upstream non livrees dont `to_token`
est une ligne relayee par CE `replica_id`, projetees en `FederatedMessage`
(`id` upstream, `to_ref`, `from_peer_id`, `from_summary`, `from_host`,
`from_cwd`, `group_id`, `text`, `sent_at` -- jamais `from_token`/`to_token`).
La replica insere chaque ligne LOCALEMENT : `to_token` = le peer local dont
`relay_ref` correspond, `from_token` = la ligne miroir de `from_peer_id` dans
le groupe (creee dormante si inconnue, pour que la FK et `resolveSenderMeta`
tiennent), `federation_id` = l'`id` upstream avec un index UNIQUE partiel
(`INSERT OR IGNORE` : un lot re-tire apres un crash ne duplique rien), puis
pousse en WS local et laisse `check_messages`/`peek` faire le reste : les
trois chemins de reception de `server.ts` sont inchanges. Les ids inseres
sont renvoyes dans `ack` au passage suivant ; l'upstream ne marque
`delivered = 1` QU'a l'acquittement. Ni la purge TTL (7 j, non livres) ni
`flushPendingForToken` ne changent.

### 2.5 Operateur et Deck

**DECIDE** (**a confirmer**, §11 Q2) -- parite avec le mode `remote`, ou
tous les Decks d'un groupe voient la meme inbox. En ligne, un
`send_message('operator')` d'un agent local est relaye a l'upstream (meme
route `/federation/send`, `to_peer_id = 'operator'`) et N'EST PAS depose
localement ; l'inbox upstream est ensuite TIREE par `/federation/sync` pour
chaque groupe, avec une session de curseur `replica:<replica_id>` (le chemin
non destructif de `handleOperatorInbox`, `broker.ts:6052-6081`, en mode
« lire au-dessus du curseur sans marquer, avancer a l'acquittement »), et
chaque ligne est deposee dans l'inbox LOCALE (expediteur = miroir, cible =
`__operator__` du groupe). Le Deck local draine son inbox loopback comme
aujourd'hui, avec ~un tick de retard ; le Deck d'une machine en mode
`remote` et ceux des autres replicas voient les memes messages. Pas de
doublon : le message n'a jamais ete depose localement. Hors ligne, ou si
l'appel echoue, depot LOCAL comme aujourd'hui (l'operateur de CETTE machine
le lit) et jamais rejoue vers l'upstream a la reconnexion (il a deja ete lu
par le seul operateur qui pouvait l'etre). Groupe `default` : refuse aux deux
bouts comme aujourd'hui, la replica n'essaie meme pas le relais.

**DECIDE** (**a confirmer**, §11 Q3) -- `handleAnnounce` local : une cible
miroir (annonce ciblee, ou chaque miroir actif d'une diffusion) est relayee
par `POST <upstream>/announce { group_id, group_secret_hash, text,
to_peer_id: <upstream_peer_id> }` -- la route Deck existante, avec le
sentinel `deck` de l'UPSTREAM comme expediteur, donc le cadrage « ne pas
accuser reception » est identique a une annonce recue en mode `remote`. Un
appel par cible, sequentiel ; un echec est journalise et compte dans
`sent` seulement s'il a abouti. La replica n'appelle jamais `/announce` sans
`to_peer_id` : la diffusion upstream toucherait ses propres peers relayes en
double.

Le Deck lui-meme ne change pas de transport et n'a rien a afficher de
nouveau pour la messagerie ; §9 liste ce qui est optionnel.

---

## 3. Tables et colonnes (un seul schema, deux roles)

Migrations idempotentes `ALTER TABLE ... ADD COLUMN`, meme motif que
`last_activity_at` (`broker.ts:485-491`).

| Table.colonne | Role | Sens |
|---|---|---|
| `peers.relay_id TEXT` | upstream | `replica_id` qui relaie cette ligne ; NULL = peer natif |
| `peers.relay_ref TEXT` | upstream | reference du peer cote replica ; `UNIQUE (relay_id, relay_ref)` partiel `WHERE relay_id IS NOT NULL` |
| `peers.via TEXT` | les deux | etiquette d'origine publique : upstream `<replica8>` ; replica `'upstream'` ou `<replica8>` ; NULL = client de CE broker |
| `peers.upstream_peer_id TEXT` | replica | nom de cette ligne chez l'upstream : alias affecte a un peer local relaye, ou vrai nom d'un miroir ; index UNIQUE partiel `(group_id, upstream_peer_id) WHERE via IS NOT NULL` |
| `messages.federation_id INTEGER` | replica | `id` upstream d'un message tire ; UNIQUE partiel `WHERE federation_id IS NOT NULL` |

Pas de nouvelle table. `roadmap_sync_meta` gagne une cle
`federation_inbox_cursor:<group_id>` (dernier `id` d'inbox acquitte par
groupe, cote replica) -- l'upstream, lui, tient le curseur dans
`operator_inbox_sessions` sous `session_id = 'replica:<replica_id>'`.

Toute colonne ajoutee a `peers` est LISTEE dans la nouvelle pick-list de
`toPublicPeer` (§7) : `via` et `upstream_peer_id` publies, `relay_id` et
`relay_ref` retenus. Un test compare la pick-list au schema vivant et
echoue sur toute colonne non decidee.

---

## 4. Contrat de protocole (`shared/types.ts`, bloc `Federation*`)

Toutes en `POST`, JSON, `{ error, status }` en echec comme les autres routes.
Bearer ordinaire + les trois gardes de §7.

| Route | Corps | Reponse |
|---|---|---|
| `/federation/sync` | `{ replica_id, groups: [{ group_id, group_secret_hash }], peers: FederationRelayPeer[], ack: { messages: number[], inbox: [{ group_id, last_id }] } }` | `{ assigned: [{ relay_ref, peer_id }], peers: FederatedPeer[], messages: FederatedMessage[], inbox: FederatedInboxMessage[], refused_groups: [{ group_id, reason }] }` |
| `/federation/send` | `{ replica_id, from_ref, to_peer_id, text }` | `SendMessageResponse` (`{ ok, error? }`) ; 404 si `(replica_id, from_ref)` n'est pas une ligne relayee par cet appelant |

```
FederationRelayPeer   = { relay_ref, peer_id, group_id, host, cwd, git_root,
                          project_key, summary, role, last_activity_at }
FederatedPeer         = { peer_id, group_id, host, cwd, git_root, project_key,
                          summary, role, status, last_seen, last_activity_at, via }
FederatedMessage      = { id, to_ref, from_peer_id, from_summary, from_host,
                          from_cwd, group_id, text, sent_at }
FederatedInboxMessage = { id, group_id, from_peer_id, text, sent_at }
```

Semantique de `sync`, dans l'ordre, en UNE transaction upstream :

1. `replica_id` valide par `REPLICA_ID_REGEX` (400 sinon). Chaque groupe
   passe par la TOFU de `/register` (`broker.ts:1885-1901` : pin au premier
   contact, 401 en cas de divergence) -- un groupe refuse va dans
   `refused_groups` et ses peers sont IGNORES, le passage continue pour les
   autres. `default` est accepte sans secret, comme partout.
2. Chaque `FederationRelayPeer` : `relay_ref` de forme `[a-f0-9]{32}`,
   `peer_id` valide par `PEER_ID_REGEX` ; un nom reserve ou pris est suffixe
   (§2.1) ; upsert par `(relay_id, relay_ref)` avec `status = 'active'`,
   `last_seen = now`. Plafond 200 peers par passage (400 au-dela : une
   replica ne porte pas mille agents).
3. Toute ligne `relay_id = replica_id` ABSENTE du corps -> `status =
   'dormant'`.
4. `ack.messages` : `UPDATE messages SET delivered = 1 WHERE id IN (...) AND
   to_token IN (lignes relayees par replica_id)` -- un id qui n'est pas
   adresse a un peer de cette replica est ignore, jamais marque.
   `ack.inbox` : avance le curseur `replica:<replica_id>` du groupe.
5. Reponse : `peers` = actifs des groupes acceptes, `relay_id IS NULL OR
   relay_id <> replica_id`, hors sentinels, projetes par pick-list ;
   `messages` = non livres adresses aux lignes relayees par `replica_id`,
   ordre `id`, plafond 200 par passage (le reste part au passage suivant) ;
   `inbox` = lignes de l'inbox operateur au-dessus du curseur de la replica
   pour chaque groupe qui peut la porter (`groupMayCarryOperatorInbox`),
   plafond 200, SANS marquer livre ni avancer le curseur.

Semantique de `send` : `from_ref` resolu en ligne relayee ; le `text` passe
par les memes limites que `/send-message` ; puis `handleSendMessage({
from_token: <token interne>, to_peer_id, text })` -- y compris le refus
`operator` en groupe `default` et le « not found in your group ». La
reponse est celle de ce handler.

---

## 5. Hors ligne : le sort des messages est un refus explicite

**DECIDE** (**a confirmer**, §11 Q1) -- aucune file d'attente. Un message
inter-machines emis hors ligne est REFUSE immediatement, l'agent recoit
`ok: false` avec la raison, et decide lui-meme (retenter, informer, passer
en local). Motifs :

- le contrat de `send_message` est deja « feu et oublie, le broker ne
  garantit que le depot » ; une file avec expiration ajouterait un troisieme
  sort (« depose puis expire ») dont l'agent ne serait jamais informe -- une
  perte SILENCIEUSE, exactement ce que le brief replica refuse pour la file
  de dispatch (§4) ;
- le relais synchrone (§2.4) EST le detecteur : entre la coupure reelle et
  la bascule de l'hysteresis (deux passages), un envoi echoue sur l'appel
  lui-meme et rend le meme refus -- pas de fenetre ou un message serait
  accepte puis perdu ;
- les messages ENTRANTS ne sont pas concernes : emis par un tiers vers un
  peer relaye pendant la coupure, ils attendent `delivered = 0` upstream
  (TTL 7 j) et arrivent au premier passage de la reconnexion. Rien n'est
  perdu cote local ; les messages locaux ne quittent jamais la machine.

Formulation du refus quand la cible est un miroir DORMANT et la replica est
`offline` : « peer 'X' is on another machine (via ...) and the upstream
broker is unreachable, working offline » -- distinct du « not found in your
group » d'un nom inconnu, pour que l'agent ne conclue pas que le peer a
disparu.

Hors ligne, `list_peers` ne montre AUCUN peer distant (tous dormants, §2.3) ;
la messagerie locale et la roadmap continuent (brief replica). A la
reconnexion : premier passage -> miroirs reactives, lignes relayees
reactivees upstream (elles y etaient passees dormantes par le sweep),
messages en attente tires, inbox rattrapee depuis le curseur.

---

## 6. Vivacite

| Signal | Cadence | Effet |
|---|---|---|
| heartbeat client -> replica | 15 s (`server.ts:2408`) | `last_seen` local, inchange |
| `/federation/sync` replica -> upstream | chaque passage de `runSyncPass`, `CLAUDE_PEERS_SYNC_TICK_MS` (5 s), backoff jusqu'a 60 s hors ligne | `last_seen = now` sur chaque ligne relayee presente ; absente -> dormante immediatement |
| `sweepInactivePeers` upstream | 60 s, seuil 120 s | replica muette -> ses lignes relayees dormantes en <= 180 s (**mecanisme existant**, aucune clause ajoutee) |
| `sweepInactivePeers` replica | idem | un miroir non rafraichi tombe dormant meme si la bascule offline n'a pas encore eu lieu |
| bascule `offline` (2 echecs) | -- | tous les miroirs dormants immediatement |

**DECIDE** -- la passe de federation s'ajoute a `runSyncPass` APRES les
trois passes roadmap (pull, push, verrous), dans la meme fonction, avec la
meme hysteresis : c'est le meme upstream, un seul minuteur, un seul
instantane de statut. Un echec de `/federation/sync` compte pour l'hysteresis
comme un echec de pull. EXCEPTION : un 404 (upstream d'une version
anterieure sans ces routes) est journalise UNE fois (« upstream does not
federate peers ») et desactive la federation pour le processus sans toucher
la replication roadmap ; les miroirs restent absents, `list_peers` reste
local, comme en v1.

Latence entrante = au plus un tick (5 s) + le WS local ; sortante = un
aller-retour upstream. (**a confirmer**, §11 Q4 : un tick dedie plus court
ou un WS replica -> upstream sont possibles plus tard, pas dans ce lot.)

Une replica dont un peer local s'est tu (heartbeat) le voit passer dormant
par son propre sweep, l'omet du passage suivant, et l'upstream le bascule
dormant dans la foulee : la replica reste la seule autorite sur la vivacite
de SES peers, comme pour ses verrous (brief replica §5).

---

## 7. Frontiere de confiance

- Les deux routes appliquent, dans cet ordre, `refuseWhenReplica`,
  `requireServeReplicas`, `requireBrokerToken` (`broker.ts:4489-4540`,
  reutilisees telles quelles : chacune interpole le nom de la route, donc
  les messages de refus sont distincts par route ET par cause), apres le
  Bearer generique. Un broker qui ne sert pas de replicas ne federe pas ;
  une replica ne federe jamais pour une autre (pas de chainage).
- `replica_id` est un identifiant, pas un secret (brief replica §6) : la
  credential est le `broker_token`. Une replica compromise mais porteuse du
  token peut mentir sur ses peers -- au meme niveau que le relais roadmap.
  Elle ne peut PAS : parler au nom d'un peer d'une autre replica (`from_ref`
  n'est resolu que sous SON `relay_id`), marquer livres des messages qui ne
  sont pas adresses a ses peers (`ack` filtre par `relay_id`), lire les
  peers ou l'inbox d'un groupe dont elle ne presente pas le bon secret
  (TOFU par groupe), s'inscrire sous `deck`/`operator`/`system`
  (`RESERVED_PEER_IDS` -> suffixe, comme `deriveDefaultId`), ni presenter un
  `relay_ref` d'une autre forme que 32 hex.
- `toPublicPeer` devient une PICK-LIST (fail-closed) dans ce lot, avec un
  test qui la compare au schema vivant de `peers` : `relay_id`, `relay_ref`,
  `instance_token`, `pid`, `client_pid`, `claude_cli_pid` retenus ; `via` et
  `upstream_peer_id` publies. Les projections `FederatedPeer`,
  `FederatedMessage`, `FederatedInboxMessage` sont des pick-lists aussi, et
  un test affirme l'ABSENCE de `instance_token`, `from_token`, `to_token`,
  `pid`, `client_pid`, `relay_ref` dans une reponse de `/federation/sync`.
- Entree hostile n°2 : un champ recu de l'upstream (`peer_id`, `host`,
  `cwd`, `summary`, `text`...) est ecrit dans des colonnes TEXT et rendu par
  `formatPeer`/`renderInbound` comme tout champ de peer -- jamais
  interpole dans une commande ni un chemin. Les longueurs sont bornees comme
  sur `/register` et `/send-message`.
- `operator_id` ne traverse pas (rien ne le porte ici) ; le Deck signe ses
  ecritures roadmap localement, inchange.
- Les tokens WS : une ligne relayee ou miroir n'est jamais dans un `wsPool`
  autre que celui de son propre broker, puisque personne ne connait son
  token.

---

## 8. La passe de federation (cote replica)

Ajoutee a `runSyncPass` apres `syncLockPass` :

1. Construire `peers` = lignes locales `status = 'active'`, `via IS NULL`,
   hors sentinels, projetees en `FederationRelayPeer` (pick-list, `relay_ref`
   calcule) ; `groups` = les groupes de ces peers avec `secret_hash` lu dans
   `groups` ; `ack` = ids inseres au passage precedent + curseurs inbox.
2. Un `POST /federation/sync`. Sur 404 : desactivation (§6). Sur 403/5xx/
   reseau : throw, hysteresis.
3. Appliquer en UNE transaction locale : `assigned` -> `upstream_peer_id`
   des lignes locales (journal `warn` une fois par alias qui differe) ;
   `peers` -> upsert des miroirs par `(group_id, upstream_peer_id)`,
   miroirs non recus -> dormants ; `messages` -> `INSERT OR IGNORE` par
   `federation_id`, WS push local pour chaque insertion effective ; `inbox`
   -> depot local vers `__operator__` du groupe, curseur memorise ;
   `refused_groups` -> journal `warn` une fois par groupe et par raison.
4. Compteurs publies dans le MEME instantane `syncPublished`, en `finally`
   (jamais a mi-passage) : `federation: { active: boolean, relayed, remote,
   refused_groups, last_error }`, exposes par `/roadmap/sync/status` sous
   une cle optionnelle `federation` de `RoadmapSyncStatus` (replica
   seulement) et par `/health` (`federation: 'on' | 'off' | 'unsupported'`).

La bascule `offline` (deja dans `runSyncPass`) execute en plus « tous les
miroirs dormants ». Rien d'autre ne change dans la boucle.

---

## 9. Clients : ce qui change et ce qui ne change pas

| Client | Change |
|---|---|
| `server.ts` | `formatPeer` rend `Via:` et `Federated as:` quand presents ; le texte de l'outil `list_peers` mentionne que les peers distants sont marques. Aucun transport, aucun corps de requete, aucun test de parite de corps (`register-body-parity`) ne bouge. |
| `cli.ts` | `peers` affiche la colonne `via` (lecture de `/admin/peers`, qui projette par la meme pick-list). |
| Deck (`desktop/`) | RIEN d'obligatoire : pas de liste de peers, `/announce` et `/operator-inbox` inchanges cote Deck (le relais est broker-side). Optionnel (**a confirmer**, §11 Q7) : `sanitizeSyncStatus` accepte `federation`, et Settings « Broker » affiche « N agents relayes, M peers distants » avec `last_error` ; deux cles de locale (`en.json`, `fr.json`, `EN_DEFAULTS`). |
| Docs | `ARCHITECTURE.md` (paragraphe « Replica mode » : peers/messages ne sont plus locaux ; routes ; pick-list), `README.md` (routes, la note « la messagerie est locale en mode replica » retiree), `BACKLOG.md` §3.9 item coche et residuels ajoutes, `DESKTOP.md` seulement si Q7 = oui. |

---

## 10. Tests

Deux fichiers nouveaux, chaque garantie posee ROUGE avant son code (message
d'assertion nommant ce qu'elle garde), via `startBroker(env)` de
`tests/_helper.ts` et le proxy bloquant de `broker-roadmap-replica.test.ts`
extrait en helper partage.

`tests/broker-federation-routes.test.ts` -- un upstream, des POST bruts qui
jouent la replica (aucune vraie replica) :

- gardes : sans `serve_replicas` -> 403 nommant `serve_replicas` ; sans
  token -> 403 nommant `token` ; sur un broker en mode replica -> 403
  nommant `replica` ; `replica_id` mal forme -> 400 ; `relay_ref` mal forme
  -> 400 ; > 200 peers -> 400 ;
- une ligne relayee est visible de `list_peers` d'un peer natif avec `via`,
  sans `instance_token`/`pid`/`relay_ref` (assertion d'absence sur la
  reponse brute) ; `toPublicPeer` pick-list vs `PRAGMA table_info(peers)` ;
- nom reserve (`deck`) et nom pris -> suffixe et `assigned` ; affectation
  collante sur deux `sync` ; renommage suivi quand le nom se libere ;
- absente du corps -> dormante immediatement ; `last_seen` rafraichi ;
  `cleanStalePeers` n'a jamais sonde une ligne `relay_id` dont `host =
  hostname()` du broker (test cross-host au meme hostname, `pid = 0`) ;
- natif -> relaye : le message reste `delivered = 0` apres un `sync` sans
  `ack`, passe `delivered = 1` apres l'`ack`, et un `ack` portant l'id d'un
  message adresse a un AUTRE peer ne le marque pas ;
- mecanique A : un `send` d'un peer relaye ne marque PAS livres les messages
  qui l'attendent (rouge d'abord : aujourd'hui `recordMessageTx` les
  marque) ;
- `send` : `from_ref` inconnu ou appartenant a une autre `replica_id` ->
  404 ; `to_peer_id = 'operator'` en `default` -> refus identique a
  `/send-message` ; inbox tiree sans marquage ni avance, avancee a l'`ack`,
  purge `scope='session'` d'un Deck respecte le curseur de la replica ;
- groupe au secret divergent -> `refused_groups`, ses peers ignores, les
  autres groupes servis ; groupe `default` sans secret servi.

`tests/broker-peer-federation.test.ts` -- un upstream U (`serve_replicas`,
token), deux replicas R1 et R2 derriere un proxy chacune, tick 150 ms, et un
peer natif C sur U ; A enregistre sur R1, B sur R2 :

- annuaire : A voit B (`via` = replica8 de R2) et C (`via = 'upstream'`),
  B voit A, C voit A et B (via respectifs) ; personne ne se voit soi-meme
  ni son alias ;
- messagerie : A -> B recu par B en WS sur R2 et par `check_messages`
  (une seule fois : `federation_id` UNIQUE) ; B -> A ; A -> C (WS sur U) ;
  C -> A ; `from_peer_id` = le nom upstream de l'expediteur ;
- operateur : A -> `operator` en ligne est absent de l'inbox R1 avant le
  tick, present dans l'inbox U et, un tick plus tard, dans l'inbox R1 ET
  R2 ; hors ligne, present dans R1 seulement, et jamais rejoue ; annonce
  Deck ciblee sur R1 vers B arrive a B cadree `deck` ;
- coupure R1 : `list_peers` de A ne montre plus B ni C ; A -> B refuse avec
  le message « working offline » ; C -> A accepte, en attente ; C voit A
  dormant apres `ACTIVE_STALE_SEC` (fixe a 2 s + sweep 1 s par env) ;
  reconnexion : A recoit le message de C, redevient actif pour C, B revisible ;
- collision : A et B renommes `same` par `set_id` ; l'un des deux est
  `same-2` upstream, `Federated as` visible sur sa replica, les deux
  joignables par leur nom upstream depuis C ;
- upstream ancien : U sans routes de federation (simule par un proxy qui
  repond 404 sur `/federation/*`) -> la roadmap continue de se repliquer,
  `status.federation.active = false`, aucune ligne d'erreur repetee.

---

## 11. Questions a trancher AVANT d'implementer

| # | Question | Proposition (DECIDE ci-dessus) | Alternative |
|---|---|---|---|
| Q1 | Sort d'un message inter-machines emis hors ligne | refus immediat, `ok: false` explicite, aucune file (§5) | file locale avec expiration (`CLAUDE_PEERS_FEDERATION_QUEUE_TTL_MIN`), perte silencieuse a l'expiration |
| Q2 | Inbox operateur | parite `remote` : relais upstream en ligne, miroir de l'inbox upstream vers chaque replica, depot local hors ligne (§2.5) | v1 stricte : `operator` reste toujours local a la machine de l'agent ; seul Deck -> agent distant traverse |
| Q3 | Annonces Deck vers les peers distants | relayees, ciblees comme diffusees (join/rotation/spawn-ack), par `/announce` upstream cible par cible (§2.5) | ciblees seulement ; ou aucune (annonces locales a la machine) |
| Q4 | Transport entrant | meme passage que la roadmap, tick 5 s, latence <= 5 s + WS local (§6) | tick federation dedie (2 s) ; ou WS replica -> upstream (lot ulterieur, `BACKLOG`) |
| Q5 | Collision de `peer_id` upstream | suffixe upstream, alias persiste et affiche `Federated as` (§2.1) | refuser le relais de ce peer (invisible et injoignable depuis les autres machines) tant que le nom est pris |
| Q6 | Interrupteur | aucun : la federation fait partie du mode `replica` ; l'upstream la gouverne deja par `serve_replicas` | `federate_peers: false` / `CLAUDE_PEERS_FEDERATE_PEERS=0` pour une replica roadmap-seule |
| Q7 | Deck | compteurs `federation` dans `/roadmap/sync/status` + deux lignes dans Settings « Broker » (§9) | rien cote Deck dans ce lot (compteurs broker-only, `/health` et journal) |
| Q8 | Groupe `default` | federe comme en mode `remote` (sans inbox operateur, deja refusee) | exclu de la federation (loopback uniquement) |

---

## 12. Refuse ou differe

- **WS replica -> upstream** pour la livraison entrante sous la seconde :
  differe, `BACKLOG.md` §3.9. Le pull par passage suffit a la parite
  fonctionnelle ; le WS ajouterait un client WS dans le broker, sa
  reconnexion et son propre cadrage d'auth.
- **Federation des approbations, dispatch, graph drafts** : hors perimetre,
  inchange (brief replica §2.2).
- **Rejeu vers l'upstream des messages `operator` deposes hors ligne** :
  refuse (l'operateur local les a lus ; un rejeu les dupliquerait sur les
  autres Decks sans contexte de date).
- **Changement d'upstream d'une replica existante** : `federation_id` ne
  porte pas l'URL de l'upstream ; re-pointer une replica vers un autre
  upstream sans vider sa base peut rejeter (`INSERT OR IGNORE`) un message
  du nouvel upstream dont l'`id` coincide avec un ancien. Note en
  `BACKLOG.md`, pas traite : le brief replica ne prevoit pas non plus ce
  changement a chaud.
- **`relay_ref` derive du token** : accepte (§2.1) ; si un jour les peers
  portent une cle publique, `relay_ref` devient son digest sans changer le
  contrat.
