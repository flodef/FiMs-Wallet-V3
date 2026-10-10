# FiMs Wallet — Audit de sécurité, 2ème passe

Date : 2025 — Revue manuelle approfondie post-remédiation (commits `eaf8cfd` → `7802385`).
Périmètre : API (`apps/api`), programme on-chain (`solana-programs`), extension, vault, client
`feature-fims`, schéma DB, CI. **Aucun code modifié — document de plan uniquement.**

> Convention : ✅ Confirmé (chemin de code identifié) · 🔶 À valider (dépend de
> config/déploiement non observable depuis le repo) · 🟡 Hypothèse (plausible, à prouver par test).

---

## 1. Résumé exécutif

La première passe de remédiation a substantiellement durci le système : simulation des
instructions custodiales, sessions SIWS + step-up, machine d'états `wrapped_claims`, invariants
on-chain autour des CPI, caps et veto guardian. **Aucune faille critique "argent volable en une
requête" n'a été trouvée dans le code relu.**

Les risques résiduels se concentrent sur quatre thèmes :

1. **Fail-open par mauvaise configuration** — plusieurs protections évaluées à l'exécution
  (breakers, caps, extras yield) deviennent silencieusement inopérantes sur une env var mal
  formée. Un NaN n'échoue jamais : il désactive.
2. **Confiance en un seul RPC** — toute la vérification de dépôts (wrapped, donations, tontine)
  repose sur `getTransaction` d'un endpoint unique. Un RPC compromis ou trompé crédite des
  montants fictifs.
3. **Hypothèses de déploiement non prouvées** — headers de proxy de confiance, programme
  redéployé ou non, multisig, rôles Postgres : le code suppose un environnement que rien ne
  garantit.
4. **Réserves de profondeur** — le garde de simulation custodial a un angle mort concret
  (comptes fermés), le KDF PIN reste faible face à l'attaque offline, le rate limiting est
  par-instance sur du serverless.

Top 5 des actions à plus fort ratio risque/effort :

| # | Action | Effort |
|---|--------|--------|
| 1 | Fail-closed sur toutes les env vars de sécurité (validation au boot) | ~2 h |
| 2 | Vérification de dépôt via 2 RPC indépendants + `finalized` partout | ~1 j |
| 3 | Simulation guard : traiter compte absent-avant/présent-après et vice versa | ~1/2 j |
| 4 | Confirmer l'état déployé réel (programme, upgrade authority, headers, rôles DB) | manuel |
| 5 | Timelock sur `accept_admin` + validation des adresses de config on-chain | ~1/2 j |

---

## 2. Modèle de menace et frontières de confiance

| Acteur | Ce qu'il peut faire | Ce qu'on suppose |
|---|---|---|
| Membre dont la clé a fuité | Signer tout ce qu'un membre signe | Step-up + caps limitent le saignement |
| dApp malveillante | Demander signatures via l'extension | Permissions par origine, garde blind-signing |
| RPC/Helius compromis | Réponses arbitraires à `getTransaction`, simulation biaisée | **Supposé honnête — hypothèse à casser** |
| Opérateur env Vercel | Modifier les env vars | **Supposé compétent — les vars fail-open le punissent** |
| Admin/délégué on-chain compromis | Appels admin/delegate | Timelock 48 h + caps + guardian — mais `accept_admin` est instantané |
| Attaquant réseau | Spoofer headers si le edge ne les assainit pas | Vercel/CF supposés écraser les headers clients |
| XSS / script même-origine | Lire `localStorage` (token bearer 7 j + état vault) | CSP mitige ; le token reste volable |

Frontière la plus fragile : **RPC → crédit ledger**. Le ledger accorde de la valeur interne sur
la foi d'une réponse `getTransaction` d'une seule source.

---

## 3. Findings — Critique

Aucun.

---

## 4. Findings — Élevée

### H-1. Garde de simulation custodial : angle mort sur les comptes fermés ✅

- **Fichier** : `apps/api/src/custodial.ts` — `assertCustodySimulation` (≈ l. 200-260),
  ligne 224 : `if (!account) continue // absent from simulation → unchanged`.
- **Explication** : le garde énumère les token accounts custody *existants avant* la
  transaction, puis ne contrôle que ceux présents dans la réponse `simulateTransaction`. Un
  compte **fermé** par la transaction (CloseAccount, ou drain intégral suivi de close) n'apparaît
  pas dans les `postTokenBalances`/accounts simulés selon le format de réponse — il est alors
  traité comme « inchangé ». Symétriquement, un compte **créé** pendant la tx (nouvel ATA
  custody, ou compte custody-owned ouvert par une CPI) n'est pas dans la liste initiale et
  échappe à tout contrôle.
- **Scénario** : une instruction yield malveillante (venue compromise ou `FIMS_YIELD_EXTRA_PROGRAMS`
  abusif) inclut un `CloseAccount` sur l'ATA custody vers une destination attaquant. Si la
  simulation ne rapporte pas le compte fermé dans les comptes inspectés, le delta mesuré est
  « inchangé » et la tx est signée/relayée.
- **Confiance** : le chemin dépend du niveau de détail des comptes retournés par la simulation
  (encoding, `accounts` de simulate). **À confirmer par un test** : construire une tx avec
  `CloseAccount` sur l'ATA custody et vérifier que le garde la rejette.
- **Impact** : contournement du dernier filet avant signature custodiale → drain possible du
  float custodial. Sévérité élevée par l'impact, probabilité conditionnée à une instruction
  malveillante passant l'allowlist structurelle.
- **Remédiation** : comparer ensemblistement les comptes custody **avant et après** simulation —
  tout compte présent avant et absent après (ou dont le owner/état change) est un rejet ; tout
  compte custody-owned apparaissant après doit être un ATA attendu. Ajouter un test négatif
  CloseAccount + delegate/owner-change.

### H-2. Breakers et caps wrapped : fail-open silencieux sur env var mal formée ✅

- **Fichier** : `apps/api/src/routes/fims/helpers.ts` l. 265-270 —
  `wrappedPriceBreaker` / `wrappedDailyCap` ; `floatTarget` (custodial) en contraste.
- **Explication** : `Number.parseFloat(process.env.X ?? '0.1')` — le `??` ne couvre que
  `undefined`. `FIMS_WRAPPED_PRICE_BREAKER=""` ou `"abc"` → `NaN`. Or toute comparaison avec
  `NaN` est fausse : le breaker de prix ne déclenche **jamais**, et `spent > NaN` est faux donc
  le cap journalier ne bloque jamais. Même motif sur le cap membre/global.
- **Scénario** : une variable vidée par erreur lors d'un edit Vercel désactive toute la
  protection circuit-breaker wrapped — sans erreur, sans log.
- **Impact** : perte silencieuse des garde-fous H1 de la phase 0. Ne crée pas la faille, la
  déclasse.
- **Remédiation** : validation de toutes les env vars de sécurité au boot (schema parse, fail au
  démarrage si absent/invalide — même pattern que `floatTarget` qui throw via `BigInt`). Inventaire
  complet des `process.env` lus à la volée dans `helpers.ts`, `custodial.ts`, `yield-placement.ts`,
  `index.ts`. Test : env invalide → refus de démarrer.
- **Effort** : faible. **Priorité immédiate.**

### H-3. Vérification des dépôts : confiance totale en un RPC unique 🟡→🔶

- **Fichiers** : `apps/api/src/solana-rpc.ts` (`fetchDonationTransaction`,
  `fetchSplDonation`), consommé par `handlers/donations.ts`, `handlers/wrapped.ts`,
  `tontine-reconcile.ts`.
- **Explication** : le ledger crédite des montants (donations, mints wrapped, carve tontine)
  sur la foi d'un `getTransaction` vers `SOLANA_RPC_URL` — **un seul endpoint, une seule clé,
  une seule réponse**. Pas de cross-vérification indépendante.
- **Scénarios** :
  - RPC compromis/malveillant ou MITM amont : renvoie une tx forgée avec `meta.err = null` et
    des `postTokenBalances` inventés → crédit de wrapped jamais backés (mint de tokens sans
    dépôt = dilution du backing, équivalent vol des autres membres au redeem).
  - Erreur honnête : indexation laggy d'un RPC public → faux négatifs ou montants obsolètes.
- **Mitigations existantes** : `finalized` pour wrapped (bien), signature = clé primaire des
  claims (idempotence), structure de la tx partiellement validée.
- **Lacunes résiduelles** :
  - **Confirmed vs finalized** : `fetchDonationTransaction` défaut à `confirmed` pour les
    donations — un reorg entre `confirmed` et `finalized` peut annuler la tx alors que le ledger
    a déjà crédité le montant **et** le poids de vote associé. Fenêtre courte mais réelle.
  - **Source non prouvée** : le delta est mesuré côté *destination* (post-balances du pot). Une
    tx où un tiers envoie des fonds au pot fait créditer le `payer` (keys[0]) — usurpation de
    donation / weight de vote. Faible impact financier, réel impact gouvernance.
  - `keys[0]` comme payeur suppose un format de tx classique ; à valider sur versioned/lookup.
- **Remédiation** : (a) deux RPC indépendants (Helius + un second provider), exiger concordance
  sur signature + meta.err + deltas avant tout crédit — au moins pour wrapped ; (b) `finalized`
  pour les donations aussi (le coût = ~13 s d'attente, acceptable en async) ; (c) valider que la
  source de la transfert appartient au membre crédité (pre/post balance du côté source, pas
  seulement destination) ; (d) alerte sur toute divergence inter-RPC.

### H-4. `optionalWalletRequest` : bypass bearer documenté nulle part ✅

- **Fichier** : `apps/api/src/services/auth/service.ts` l. 172.
- **Explication** : sur absence de `Authorization`, l'utilisateur est anonyme — attendu. Mais
  sur présence d'un bearer `fims_session_…` **invalide/expiré/inconnu**, le code retourne
  `Option.none()` au lieu de rejeter : l'utilisateur est **déclassé en anonyme silencieusement**
  au lieu de recevoir 401.
- **Impact réel** : les seuls consommateurs sont des filtres de *visibilité* (voir plus vs moins
  de membres) — pas d'escalade. Mais c'est un footgun : si un futur handler utilise
  `optionalWalletRequest` pour un chemin authentifié-optionnel à effet (personnalisation,
  quotas), un token volé-révoqué continue de fonctionner « en anonyme ». Et côté client, un
  token expiré dégrade silencieusement l'UX (membre se croit connecté, voit la vue publique).
- **Remédiation** : distinguer « pas de header » → anonyme, de « header présent mais invalide »
  → 401. Documenter le contrat. Vérifier chaque appelant actuel et futur.

---

## 5. Findings — Moyenne

### M-1. Confiance aux headers de proxy → spoofing d'IP, bypass du rate limit ✅🔶

- **Fichier** : `apps/api/src/index.ts` l. 22-30 — priorité `cf-connecting-ip` >
  `x-vercel-forwarded-for` > `x-real-ip` > `x-forwarded-for`.
- **Explication** : si le edge ne **réécrit pas** ces headers (ex. déploiement hors Vercel, ou
  Vercel sans CF où un client peut envoyer `cf-connecting-ip` arbitraire), l'attaquant choisit
  son IP → buckets frais infinis → rate limiting inopérant (et pollution du `rate_limits`
  Postgres partagé).
- **À valider** : sur Vercel, `x-vercel-forwarded-for` est fixé par la plateforme (sûr) ;
  `cf-connecting-ip` n'est fiable que derrière Cloudflare. Si la prod est Vercel *sans* CF, la
  priorité donnée à `cf-connecting-ip` est un **header forgeable prioritaire** — ordre à
  inverser ou liste blanche de headers selon l'env.
- **Remédiation** : ne lire que le header que la plateforme déployée garantit (env-driven) ;
  ignorer les autres. Test d'intégration : requête avec header forgé → bucket de l'IP réelle.

### M-2. Rate limiting par instance sur du serverless ✅

- **Fichier** : `apps/api/src/index.ts` — buckets mémoire pour les reads (240/min/IP) ;
  Postgres partagé seulement pour les mutations.
- **Explication** : chaque instance/isolate Vercel a sa propre Map → la limite réelle est
  `240 × nb_instances`. Sur un burst multi-instances, le plafond effectif explose. La Map
  (jusqu'à 10 000 entrées, purge opportuniste) est aussi un vecteur d'exhaustion mémoire lent
  via IPs forgées (M-1 amplifie).
- **Remédiation** : limiter le bucket mémoire au strict cache-local (TTL court, taille bornée
  LRU) ; considérer le même chemin Postgres pour les reads coûteux (chain proxy, session) ou un
  rate-limit edge (Vercel/CF natif). Au minimum, documenter que la limite read est « best
  effort par instance ».

### M-3. Session bearer 7 j dans `localStorage`, pas de rotation ni de GC ✅

- **Fichiers** : `packages/feature-fims/src/fims-api.ts` (cache + localStorage),
  `apps/api/src/services/auth/service.ts` (création/vérif).
- **Explication** : le token est en `localStorage` → tout script même-origine (XSS résiduelle,
  dep compromise) exfiltre un bearer valable 7 j, utilisable depuis n'importe quel device/origine
  (pas de device-binding, pas de rotation). La table `fims_sessions` n'a **aucun job de purge** :
  accumulation de sessions expirées (bruit d'audit, surface de lookup). Le hash stocké est bon
  (pas de token en clair), la révocation existe — c'est le cycle de vie qui manque.
- **Remédiation** : purge périodique des sessions expirées (même cron que `rate_limits`) ;
  rotation du token à mi-vie côté client ; envisager de lier la session à un fingerprint (UA +
  prefixe d'IP, alerte sur changement) — documenter le compromis UX. CSP stricte déjà en place
  reste la mitigation XSS principale.

### M-4. Redeem refusé quand le float est insuffisant, même si le backing existe en yield ✅

- **Fichier** : `apps/api/src/custodial.ts` l. ~503 — `float < required → rejet`.
- **Explication** : le redeem exige le montant en ATA custody « flottant ». Si les fonds sont
  placés en yield (comportement voulu — M5/Phase 2 les y met), tout redeem au-delà du float est
  refusé jusqu'à ce qu'un opérateur/keeper rapatrie. C'est un **gel de retraits par design**.
- **Impact** : bank-run partiel → les premiers servis, les suivants bloqués sans message clair.
- **Remédiation** : au lieu de rejeter, déclencher (ou queue-er) un retrait yield → redeem
  différé avec état visible dans `wrapped_claims` (`awaiting_liquidity` ?) ; ou garantir un
  float minimum opérationnel + runbook. Au minimum, message d'erreur explicite « liquidité en
  cours de rapatriement » + alerte ops.

### M-5. `accept_admin` instantané — contourne la philosophie du timelock ✅

- **Fichier** : `solana-programs/programs/fims-strategy/src/lib.rs` l. ~914 —
  `state.admin = proposed` immédiat ; constraste avec `schedule_config` 48 h.
- **Explication** : tout changement de config passe par un timelock 48 h + veto guardian, **sauf
  le changement d'admin lui-même** : admin propose, le nouveau accepte, effet immédiat. Une clé
  admin compromise transfre le rôle instantanément — le guardian ne peut pas veto un handover
  déjà signé. Le nouvel admin malveillant doit encore timelocker ses configs (48 h de fenêtre
  guardian), donc le vol immédiat est borné — mais la **perte du rôle est irréversible sans
  coopération du nouvel admin**.
- **Remédiation** : router le changement d'admin **dans** le mécanisme `schedule_config` (nouveau
  `ConfigChange::Admin`, délai 48 h, veto guardian, puis accept par le pending_admin). Effort
  faible, cohérence forte.

### M-6. `apply_config` : adresses de config non validées (treasury, delegate) ✅

- **Fichier** : `solana-programs/.../lib.rs` l. ~870 — `ConfigChange::Treasury` /
  `Delegate` appliqués sans `Pubkey::default()` ni check de système-owned.
- **Explication** : treasury/delegate passent bien par le timelock 48 h (chemin
  `schedule_config` → `apply_config` — conforme à la convention AGENTS.md), mais la **valeur
  appliquée n'est pas validée** : `treasury = Pubkey::default()` (typo ou malice) → les sweeps
  envoient des fonds à une ATA d'une clé inexistante → **burn irrécupérable**. Idem
  `delegate = default` → keeper mort, fonds gelés jusqu'à nouvelle config (48 h de plus).
- **Remédiation** : dans `apply_config` (ou `validate_config`), rejeter `Pubkey::default()` pour
  toute adresse de rôle ; exiger treasury ∈ sysvar-owned. Test négatif par config.

### M-7. KDF trop léger pour l'entropie d'un PIN à 4 chiffres ✅ (limitation connue, à documenter)

- **Fichiers** : `packages/vault/src/wallet-protection.ts`, `encrypted-value-schema.ts`,
  `unlock-throttle.ts`.
- **Explication** : PBKDF2 600 k itérations protège un mot de passe correct ; pour un PIN
  4 chiffres (10⁴), l'attaque **offline** sur un vault exfiltré est triviale (~minutes). Le
  throttle progressif est en `localStorage` — **réinitialisable par l'attaquant**, il ne vaut
  que contre des essais via l'UI. Le risque est *communiqué* à l'utilisateur (warning « PIN
  faible »), ce qui est la bonne réponse produit — mais le gap reste structurel.
- **Remédiation** : (a) s'assurer que les warnings indiquent explicitement l'attaque **offline**
  (« si votre appareil est volé/compromis, un PIN à 4 chiffres ne protège pas ») ; (b) évaluer
  un KDF memory-hard (argon2id via WASM, ou `scrypt`) pour le mode PIN — coût UX faible, gain
  réel ; (c) à terme, Secure Enclave/WebAuthn PRF pour lier le secret au device.

### M-8. Proxy chaîne : oracle gratuit pour adresses arbitraires ✅

- **Fichier** : `apps/api/src/routes/fims/handlers/chain.ts` — `handleChainTransactions`,
  `handleChainAssets` ; quota `consumeChainQuota` par signer.
- **Explication** : tout membre authentifié peut interroger Helius **pour n'importe quelle
  adresse** via notre clé payée — le quota par wallet (60/10 min) borne mais n'empêche pas
  l'usage comme API Helius gratuite (indexer des whales, scraping). Le coût est le nôtre.
- **Remédiation** : restreindre `urlParams.address` aux adresses **liées au membre** (son
  canonical + aliases), ou liste blanche d'adresses protocolaires ; le cas d'usage « regarder
  une adresse arbitraire » n'existe pas dans le produit — à confirmer.

### M-9. `FIMS_YIELD_EXTRA_PROGRAMS` : élargissement de l'allowlist par env 🔶

- **Fichier** : `apps/api/src/yield-placement.ts`.
- **Explication** : la liste de programmes yield de confiance est extensible par env var —
  nécessaire opérationnellement, mais **un edit Vercel élargit la surface de CPI custodiale sans
  revue de code**. Combiné à H-1 (angle mort simulation), un programme « extra » malveillant est
  le chemin d'attaque le plus direct.
- **Remédiation** : traiter cette env comme du code — revue obligatoire (règle ops) ; en durcir
  le parsing (fail-closed comme H-2) ; envisager une liste en dur + env qui ne fait que
  *restreindre*. Documenter dans le runbook que toute addition = changement de sécurité.

### M-10. Réassignation `FIMS_ADMIN_ADDRESSES` sans check de collision identité ✅

- **Fichier** : `apps/api/src/fims-constants.ts` / helpers admin.
- **Explication** : le set admin est lu depuis l'env. Ajouter une adresse admin qui est déjà
  `canonical_address` ou alias d'un user existant crée un membre qui est *à la fois* admin et
  membre votant — les gardes `requireAdmin`/`requireMember` n'excluent pas ce croisement.
  Inversement, retirer une adresse admin laisse le user associer un rôle fantôme.
- **Remédiation** : au boot ou à la création de user, rejeter toute adresse ∈ admin comme
  canonical/alias ; test unitaire du croisement admin∩member.

### M-11. `neon()` connect/end par requête dans le rate limiter partagé ✅

- **Fichier** : `apps/api/src/index.ts` — limiteur mutations Postgres.
- **Explication** : chaque check ouvre une connexion Neon HTTP et la ferme — coût par requête +
  fragilité si la DB rame (le fallback mémoire fail-open absorbe, mais perd la partage). Pas un
  trou, un anti-pattern de résilience.
- **Remédiation** : réutiliser le client `neon()` mutualisé (déjà fait pour les reads) ou le
  pool du `DatabaseService` ; mesurer la latence ajoutée aux mutations.

### M-12. Donations vérifiées à `confirmed`, pas `finalized` ✅

- Voir H-3 — décliné séparément car fix indépendant : les donations (qui alimentent **poids de
  vote** et historique financier) acceptent `confirmed`. Une tx reorgée entre confirmed→finalized
  laisse un crédit fantôme. Fenêtre ~seconds sur Solana mainnet, impact modéré.
- **Remédiation** : `finalized` uniforme pour tout ce qui crédite le ledger ; l'attente est
  absorbée par le caractère async du claim.

---

## 6. Findings — Basse / Informationnelle

| # | Findings | Fichier | Note |
|---|---|---|---|
| L-1 | Poids de vote calculés en float sur montants exacts | `helpers.ts` `loadVoteWeights` | Cohérent avec la frontière « valorisation = float », mais les comparaisons de seuils (quorum) devraient être défensives (epsilon) |
| L-2 | Purge probabiliste des `rate_limits`/sessions | `index.ts`, `service.ts` | Nettoyage au fil de l'eau ; un cron de purge rend le comportement prévisible |
| L-3 | `maxSupportedTransactionVersion` absent des `getTransaction` | `solana-rpc.ts` | Les txs v0/lookup peuvent être parsées différemment ; vérifier le format de `keys[0]`/balances sur versioned |
| L-4 | `handleGetUser` expose `riskTargets` dans la vue publique | `handlers/users.ts` | Champ stratégie potentiellement sensible pour un profil `isPublic` — vérifier qu'il doit être public |
| L-5 | `schedule_config` écrase un pending existant silencieusement | `lib.rs` | Un admin peut remplacer sa propre config timelockée en cours ; l'event le trace, mais un `require!(pending.is_none())` serait plus sûr (ou explicite "remplace") |
| L-6 | Grants extension sans expiration | `extension/services/permissions.ts` | Un grant de signature persiste indéfiniment ; envisager TTL ou révocation au change de compte |
| L-7 | Sous-requêtes corrélées par user (`handleGetUser`) | `handlers/users.ts` | Pattern N+1 latent si liste étendue ; joindre/agréger si ça devient un listing |
| L-8 | `custodialBackingStatus` : `Math.ceil(Number(supply)*price)` en float | `custodial.ts` | À très gros supply, le required peut être sous-estimé → faux « healthy » ; passer en bigint-scaled comme `convertPosition` |
| L-9 | Yield balance en échec → compté 0 | `custodial.ts` backingStatus | Choix sain (alerte plutôt que faux healthy) mais indistinguable d'un vrai sous-collatéral — distinguer « RPC down » vs « undercollateralized » dans le statut |
| L-10 | Prefix-denylist pour l'auth message côté extension | `services/sign-guards.ts` | Bloquer un préfixe reste contournable par un message équivalent encodé autrement ; la cible propre = capacité (l'API n'accepte que son format signé canonique, l'extension refuse de signer des bytes qui *parsent* comme SIWS) |
| L-11 | Builders SIWS/link dupliqués client↔serveur | `fims-api.ts` vs `service.ts`/`helpers.ts` | Drift possible → login cassé ou signature acceptée d'un côté pas de l'autre ; même remède que `fims-constants.spec` : un test qui parse les deux copies |
| L-12 | `auditAdmin` colonne `admin_address` pour tout signer | `helpers.ts` | Renommage historique assumé — à documenter, les analystes liront « admin » pour un acte membre |
| L-13 | Heuristique « ressemble à une tx sérialisée » dans sign-guards | `sign-guards.ts` | Peut faux-positiver sur des payloads légitimes ; accepter le coût (mieux vaut refus que blind-sign) mais logger les refus pour mesurer |
| L-14 | `CORS_ORIGINS` fallback permissif | `index.ts` | Vérifier la valeur prod — un `*` + Authorization bearer serait mauvais ; allowlist stricte attendue |
| L-15 | Pas de quota sur session-create / verify | `handlers/session.ts` | Création de session = signature vérif + insert ; spam possible sous limite mutation globale seulement |

---

## 7. Contrôles positifs (déjà solides — ne pas régresser)

- **On-chain** : invariants lamports/owner/data_len autour des CPI, `TransferChecked` + delta
  réel, sweep borné aux mints non-stratégiques + cap partagé, veto guardian
  (`guardian_cancel_pending`), timelock 48 h config — `apply_config` s'applique **en pause**
  intentionnellement (la rotation delegate/admin doit pouvoir s'appliquer pendant le gel),
  rolling-window caps (implémentation bucket horaire correcte), PDA seeds vérifiés.
- **API** : sessions hashées (pas de token en clair), step-up signature fraîche + anti-rejeu
  `used_signatures`, machine d'états `wrapped_claims` transactionnelle, lease keeper avec TTL,
  simulation custodiale + allowlist structurelle yield, caps wrapped/journaliers (quand les envs
  sont saines — cf. H-2), audit log append-only sur tout signer, erreurs sanitisées, CSP prod,
  quotas Helius par wallet.
- **Crypto client** : AES-256-GCM, PBKDF2 600 k (mots de passe), envelope validée par schema,
  throttle progressif, warnings explicites PIN faible / non-custodial assumé.
- **Extension** : permissions par origine+compte persistantes, rejet du préfixe auth FiMs,
  heuristique tx-serialisée, SIWS domain-bound.
- **DB** : unicités address/name/alias, PK composite `donations(signature,mint)`,
  `transactions_user_request_uniq`, contraintes de la machine d'états claims.
- **Ledger** : montants en `numeric` string-exacts, arithmétique bigint scaled sur
  `convertPosition`/`wrappedTransfer`, sources on-chain via `rawAmount` bigint.
- **CI** : typecheck 29/29, tests API+client, job Rust (clippy/fmt/tests), images épinglées,
  test anti-drift des constantes.

---

## 8. Plan de remédiation priorisé

### Immédiat (cette semaine — faible effort, fort gain)

1. **H-2** — Validation fail-closed de toutes les env vars de sécurité au boot (breaker, caps,
  floats, extras yield, CORS). Un `NaN` doit crasher le déploiement, pas désactiver un garde.
2. **L-8** — `custodialBackingStatus` en arithmétique exacte (bigint scaled) — 20 lignes, élimine
  le faux-healthy à grande échelle.
3. **M-10** — Rejeter les croisements admin∩member au boot + test.
4. **M-1** — Vérifier quel header la prod peut garantir ; n'en lire qu'un (ou allowlist par env).
5. **H-4** — `optionalWalletRequest` : bearer présent-mais-invalide → 401 (séparer « absent »
  vs « invalide »).

### Court terme (2 semaines)

6. **H-1** — Garde simulation : comparaison ensembliste avant/après (fermés, créés, owner/delegate
  changés) + tests négatifs CloseAccount/delegate. **Prérequis : test de reproduction d'abord**
  pour confirmer l'angle mort sur le RPC de prod.
7. **M-5 + M-6** — On-chain : `ConfigChange::Admin` timelocké, validation `Pubkey::default()`
  sur treasury/delegate. → À embarquer dans le **même redéploiement** que Phase 1 (une seule
  upgrade au lieu de deux).
8. **H-3** — Double-RPC pour les crédits ledger (au moins wrapped) + `finalized` uniforme (M-12)
  + validation source-side des transferts.
9. **M-4** — Politique de liquidité redeem : état `awaiting_liquidity` dans `wrapped_claims` +
  float minimum garanti + runbook.
10. **M-3** — Cron purge sessions + rotation token à mi-vie.
11. **M-8** — Restreindre le proxy chaîne aux adresses du membre.

### Moyen terme (avant scaling / montée de TVL)

12. **M-7** — KDF memory-hard pour PIN + messaging offline-attack explicite ; évaluer
    WebAuthn-PRF/Secure Enclave.
13. **M-2** — Rate limiting edge (Vercel/CF) pour les reads ; Postgres pour tout ce qui a un coût.
14. **L-10** — Auth par capacité : le serveur n'accepte que *son* format canonique → la denylist
    extension devient du defense-in-depth, plus une frontière.
15. **M-9** — `FIMS_YIELD_EXTRA_PROGRAMS` traité comme changement de code (règle ops écrite).
16. Durcissement tests : négatifs par config (chaque `Pubkey::default()` → refus), fuzz des
    montants wrapped (propriété : mint+redeem ≈ identité à fee près), test de la course
    `wrapped_claims` (deux claims même signature → un seul crédit).

### Assurance externe (inchangé)

17. Audit formel du programme (2 firmes — le diff Phase 1 + M-5/M-6 doit être relu **avant**
    redéploiement, pas après).
18. Fuzzing CPI + invariant testing (trident/surfpool).
19. Bug bounty une fois la surface stabilisée.

---

## 9. Questions de validation déploiement (🔶 — à confirmer manuellement)

| # | Question | Si « non » → |
|---|---|---|
| 1 | Programme redéployé avec Phase 1 ? (`Fims7…` binary hash vs source) | H-2/H-3/H-4 on-chain non actifs en prod |
| 2 | Upgrade authority + admin derrière Squads multisig ? | `accept_admin` et les upgrades contournent tout |
| 3 | Headers `cf-connecting-ip`/`x-vercel-forwarded-for` écrasés par le edge ? | M-1 exploitable |
| 4 | `FIMS_BACKING_VAULT` + `FIMS_*_YIELD_ASSET` renseignés ? | backingStatus aveugle aux positions yield |
| 5 | Toutes les `FIMS_WRAPPED_*`/floats définies et bien formées ? | H-2 en production |
| 6 | Rôles Postgres moindre privilège sur la Neon unique (API ≠ ETL : l'API ne devrait pas écrire `tokens`) ? | Une compromission API écrit `tokens` |
| 7 | `SOLANA_RPC_URL` = provider privé de confiance (pas un RPC public) ? | H-3 amplifié |
| 8 | `CORS_ORIGINS` = allowlist explicite ? | L-14 |
| 9 | Version API déployée = source actuelle ? | Toute la remédiation non live |
| 10 | Alertes branchées : backing-status unhealthy, keeper failed, claim stuck ? | Les gardes existent mais personne n'écoute |

---

## 10. Registre des validations par test (pour transformer 🟡 en ✅/❌)

- **H-1** : tx simulée contenant `CloseAccount` sur ATA custody → le garde doit rejeter (aujourd'hui : à prouver).
- **H-3** : tx où un 3ᵉ compte alimente le pot avec `keys[0]` = membre → le membre est-il crédité à tort ?
- **M-1** : requête avec `cf-connecting-ip` forgé en prod-like → IP réelle ou forgée dans le bucket ?
- **M-4** : redeem > float avec yield provisionné → 503 ou file d'attente ?
- **L-3** : donation via tx v0/ALT → parsing `keys[0]`/balances correct ?
- **Course claims** : deux `wrappedTransfer` simultanés même signature → exactement un mint.

---

## 11. Suivi d'implémentation

Statut au commit « audit-2 fixes » — ✅ implémenté + vérifié, 🟡 implémenté (validation prod requise), 🔶 manuel/ops, ⬜ reporté.

### Élevée

- ✅ **H-1** — Garde simulation : compte absent post-sim = rejet (fermeture), owner inchangé exigé, delegate/close-authority/state diffés (`assertCustodySimulation` + 5 tests négatifs `custodial-sim.spec.ts`)
- ✅ **H-2** — `env.ts` fail-closed (`envFloat`/`envInt`/`envBigint`/`envList`) : breakers wrapped, caps, floats, `STRATEGY_LTV_BPS`/`STRATEGY_ALERT_SECS`, `FIMS_YIELD_EXTRA_PROGRAMS` (adresses validées)
- ✅ **H-3** — `finalized` par défaut, `FIMS_VERIFY_RPC_URL` double-provider concordance (mismatch → throw), `payerSourced` par delta + filtré dans donations/wrapped/reconcile, `maxSupportedTransactionVersion: 0`
- ✅ **H-4** — `optionalWalletRequest` : bearer présent-mais-invalide → 401 (plus de déclassement anonyme)

### Moyenne

- ✅ **M-1** — `RATE_LIMIT_IP_HEADER` : un seul header de confiance (défaut `x-vercel-forwarded-for`), fallback `unknown` partagé
- ✅ **M-2** — Buckets mémoire bornés (éviction LRU au-delà de 10k) ; le reste est ops (edge limiting)
- ✅ **M-3** — Purge opportuniste des sessions expirées dans `verifyBearerSession`
- ✅ **M-4** — État `awaiting_liquidity` : redeem sans float → claim en file (caps déjà validés), retry via `processQueuedRedeems` dans le tick keeper ; float-check désactivé quand un venue yield est configuré. Settlement atomique : `UPDATE … WHERE state=` à chaque transition (claim → minted → recorded, recorded posé AVANT l'insert ledger — pas de double-settle ni de doublon ledger), sentinel-throw `WrappedClaimInFlight` pour rollback complet d'un claim perdu (un `return` committerait les écritures partielles), lease keeper `wrapped-redeem`, breaker prix appliqué au settle comme au chemin live (`lastImpliedWrappedPrice` partagé)
- ✅ **M-5** — `ConfigChange::Admin` timelocké (variant 7, index borsh préservés), `propose_admin` supprimé, `accept_admin` finalise — vérifié on-chain (PoC)
- ✅ **M-6** — `Pubkey::default()` rejeté pour Treasury/Delegate/Admin au `schedule_config` — PoC
- ✅ **M-7** — Décision documentée : le warning existant couvre déjà l'attaque offline (« brute-force it offline, and a 4-digit PIN falls in seconds ») ; argon2 sur 10⁴ combinaisons < 10× de gain — pas de nouvelle dep crypto ; mitigation réelle = longueur recommandée + device-binding futur
- ✅ **M-8** — Proxy chaîne restreint aux adresses liées du membre + tontine/treasury (admins illimités)
- ✅ **M-9** — `FIMS_YIELD_EXTRA_PROGRAMS` fail-closed + documenté AGENTS.md comme changement de sécurité
- ✅ **M-10** — Adresses admin rejetées comme canonical/alias member (createUser, updateUser, addUserAddress)
- ✅ **M-11** — Client `neon()` déjà mutualisé (`sharedSql`) — vérifié, rien à changer
- ✅ **M-12** — `finalized` uniforme (voir H-3)

### Basse / info

- ✅ **L-2** — Purges opportunistes sessions + rate_limits + used_signatures
- ✅ **L-3** — `maxSupportedTransactionVersion: 0`
- ✅ **L-4** — `riskTarget` masqué (null) hors propriétaire/admin dans `handleUsers`
- ✅ **L-5** — `pending.is_none()` + `admin_cancel_pending` — PoC
- ✅ **L-6** — Grants extension : TTL 90 j + auto-révocation
- ✅ **L-8** — `custodialBackingStatus` en bigint scaled (ceil, jamais sous-estimé)
- ✅ **L-9** — `yieldUnreadable` dans BackingStatusRow (RPC down ≠ unbacked)
- ✅ **L-10** — Denylist étendue : `fims-confirm\n` + marqueur SIWS session (les 3 familles de messages API)
- ✅ **L-11** — `fims-messages.spec.ts` : drift-test des builders SIWS/link/confirm client↔serveur
- ⬜ **L-1** — Poids de vote float (epsilon quorum) — accepté, cohérent frontière valorisation
- ⬜ **L-7** — Sous-requêtes corrélées — pas un problème à l'échelle actuelle
- ⬜ **L-12** — Nommage `admin_address` — convention documentée dans le code
- ⬜ **L-13** — Heuristique tx-sérialisée : faux positifs acceptés par design (log côté request service)
- 🟡 **L-14** — `CORS_ORIGINS` — code = allowlist stricte ; valeur prod à confirmer 🔶
- 🟡 **L-15** — session-create sous limite mutation partagée (120/min/IP) — suffisant tant que la limite globale tient

### Ops restantes (inchangées — intervention manuelle)

- 🔶 Redéployer le programme (inclut Phase 1 + M-5/M-6 — une seule upgrade)
- 🔶 Squads multisig upgrade authority + admin
- 🔶 `FIMS_VERIFY_RPC_URL` à provisionner (provider indépendant)
- 🔶 `RATE_LIMIT_IP_HEADER` à confirmer selon l'edge réel (CF devant Vercel ?)
- 🔶 Rôles Postgres, envs `FIMS_*_YIELD_ASSET`, audit externe

*Fin du rapport.*
