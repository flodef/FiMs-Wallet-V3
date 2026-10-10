# Security Remediation Plan

Suivi de l'implémentation du plan de remédiation issu de l'audit de sécurité.
Demander « montre-moi le plan » ou ouvrir ce fichier pour voir l'avancement.

Légende : ⬜ à faire · ✅ fait · 🔶 partiel / action manuelle requise

## Phase 0 — Containment immédiat

- ✅ C1 — Validation des instructions yield (allowlist programId, refus SetAuthority/MintTo/Approve/CloseAccount/transfers System, simulation + vérification des deltas avant signature par la clé custodiale) — `apps/api/src/yield-placement.ts`, `apps/api/src/custodial.ts`
- ✅ C2 — Extension `signMessage` : refuser les bytes qui se décodent en tx Solana, afficher le message (UTF-8 / hexdump + warning), refuser le préfixe `fims-wallet-v3\n`, afficher compte + origine, i18n — `packages/background`, `packages/feature-request`
- ✅ C3 — Extension : capturer l'origine depuis `sender`, table de permissions par origine (connect/révocation), rejet des signatures hors origine connectée, vérif SIWS domain == origin, signer avec le compte demandé, RPC du réseau actif pour signAndSend
- ✅ H1 — `wrappedTransfer` : fraîcheur du prix (`PRICE_STALE_MS`), borne de variation vs prix précédent, fee/spread, plafonds par membre et globaux 24h — `apps/api/src/routes/fims/http.ts`
- ✅ H1b — Confirmation `finalized` sur mint/redeem + montants en `bigint` (uiTokenAmount.amount, pas de float)
- 🔶 Séparer dev/prod (rôles Postgres moindre privilège) — action infra manuelle

## Phase 1 — Programme on-chain

- ✅ H2 — Invariants autour des CPI whitelistées : lamports / owner / data_len du vault et de `state` inchangés — `lib.rs` `cpi_whitelisted`
- ✅ H3 — `sweep` : exclure collatéral/share/position mints, plafond via spend_window
- ✅ H4 — `guardian_cancel_pending` + veto, validation `StrategyConfig`/`Caps` (tx_cap ≤ daily_cap, vaults_program whitelisté, extensions T22). `apply_config` s'applique **en pause** — par design : la rotation delegate/admin timelockée doit pouvoir s'appliquer pendant le gel d'un delegate compromis
- ✅ M6 — `TransferChecked` pour dépôt, enregistrer le delta réellement reçu, vérifier décimales collateral == share, refuser extensions T22 dangereuses à la config
- 🔶 Upgrade authority + admin → multisig Squads avec timelock — action manuelle post-déploiement

## Phase 2 — API

- ✅ H5 — Session SIWS (signature unique liée au domaine → bearer 7j hashé sha256) ; step-up `fims-confirm` pour actions sensibles ; migration `0015_fims_sessions` appliquée en prod
- ✅ M1 — `chainLabels` : membres non-publics invisibles hors owner/admin, carnet d'adresses limité aux entrées du propriétaire
- ✅ M2 — `deleteUser`/`addUserAddress`/`removeUserAddress` réservés à l'adresse canonique (ou admin) + step-up signature ; audit trail étendu à tous les signataires
- ✅ M3 — Cap `convertPosition` vérifié sous verrou membre dans la transaction ; donations enregistrées via claim transactionnel `donation:{sig}` (pas de doublon concurrent) ; cooldown ballot sous verrou
- ✅ M4 — Custodial : machine d'états `wrapped_claims` (claimed → minted → recorded, migration `0016`), replay du ledger sans re-mint, legs `claimed` bloquants avec déblocage admin, sweep sorti de la requête (keeper `custodialSweep`), `maxDuration` 300 s sur la fonction API
- ✅ M5 — Keeper : lease TTL `keeper_locks` (migration `0017`), reprise horaire des placements `failed` (5/passe), rejet d'un quote sans `otherAmountThreshold`
- ✅ M9 — CSP prod sans `localhost:*` + `upgrade-insecure-requests` ; erreurs chaîne/custodial génériques (détail en logs) ; quota Helius par wallet (60/10 min via `rate_limits`)

## Phase 3 — Produit, bugs, refactors

- ✅ M7 — Réconciliation tontine côté serveur : le keeper scanne les signatures du pot et enregistre les versements de membres (claim transactionnel, paiement lié vérifié)
- ✅ M8 — Alerte rouge pour `FIMS_DEMO_RECIPIENT` : warning critique dans l'inspection dApp (`demoRecipient`) + `UiWarning` sur l'écran d'envoi
- ✅ Bug — `createVote` : audit unique + insertion vote/options atomique
- ✅ Bug — `custodialBackingStatus` inclut le backing placé en yield (`FIMS_*_YIELD_ASSET`, ≈1:1)
- ✅ Bug — `wrappedTransfer` : tous les deltas du tx traités (Phase 0)
- ✅ Bug — tx soumise comme donation puis dépôt wrapped : le check `existing` ne bloque que les lignes `{sig}:{mint}` ; claims `claimed` restants : déblocage admin par suppression de la ligne `wrapped_claims` après vérif on-chain
- ✅ Bug — Commentaires custodial (NAV pas 1:1, ledger EURF/USDF)
- ✅ Refactor — `requireMember` mutualisé, base58 via `@solana/codecs-strings`, `rpcCall`/`tokenBalance`/`fetchProviderInstructions` mutualisés dans `solana-util.ts`, constantes FiMs dédupliquées dans `fims-constants.ts`, **`http.ts` découpé** : glue de 99 lignes + `helpers.ts` + 10 fichiers `handlers/` par domaine (session, users, ledger, book, votes, donations, convert, wrapped, chain, cron)
- ✅ `.catch(() => {})` → logging (`console.warn`) sur les chemins critiques (démo, approvals, lease keeper, onboarding)
- ✅ i18n `feature-request` : dialogue de déverrouillage traduit (en/fr/es)
- ✅ Montants décimaux exacts — `transactions.amount`/`donation_amount` lues/écrites comme strings `numeric` exactes (les deltas on-chain passent par `rawAmount` bigint + `formatTokenUnits`, plus de `Number(raw)/10^d`) ; `convertPosition` divise en bigint scaled 1e9 (même pattern que wrappedTransfer) ; `cost`/`movement` restent float (valorisation EUR, pas unité de compte) ; colonnes DB inchangées → pas de migration. **Décision documentée :** pas de codec `Decimal` complet — les calculs d'affichage EUR restent float64 car aucun invariant exact ne s'applique à des valorisations dont les prix d'entrée sont déjà approximatifs
- ✅ Constantes protocolaires : gardées dupliquées (API standalone) mais verrouillées par `fims-constants.spec.ts` qui lit la copie client et échoue sur drift

## Phase 4 — Assurance externe (manuel)

- 🔶 Audit formel (2 firmes) du programme + flux custodial
- 🔶 Fuzzing CPI comptes adversariaux, tests fork mainnet
- 🔶 Bug bounty
- 🔶 CI Rust : job ajouté (fmt, clippy, tests, `cargo-build-sbf --arch v3`) — reste le premier run à valider
- ✅ Surfpool épinglé à `1.6` (plus de `:latest` en CI)

## Notes

- ✅ = fait dans cette session (voir commits). Phase 2 livrée : sessions SIWS
  H5, visibilité/alias/races M1-M3, machine d'états custodial M4, verrou +
  reprise keeper M5, CSP + quotas + sanitisation M9, carve tontine auto M7,
  alerte démo M8, bugs fonctionnels (vote atomique, backing-status yield,
  déblocage donation↔wrapped), refactor requireMember + base58, CI Rust.
  Migrations 0015/0016/0017 appliquées et vérifiées en prod. Deuxième passe :
  découpe http.ts en handlers par domaine, noms membres normalisés (NFKC,
  casse-insensible, ≤40, démo figée à « Démo »), votes bornés (titre ≤80,
  options ≤16×80, description ≤1000), client neon mutualisé dans le rate
  limiter, i18n unlock-dialog, logging des catch silencieux, surfpool épinglé.
  Troisième passe : montants ledger en décimal exact (amount/donation_amount
  en numeric string bout-en-bout), test anti-drift des constantes
  protocolaires, maxDuration Vercel 300 s.
- ✅ = fait dans cette session (voir commits). Phase 1 livrée : invariants
  lamports/owner/data du vault autour des CPI (VaultDrained), sweep restreint
  aux mints non-stratégiques + plafonné (cap token partagé), veto guardian
  (guardian_cancel_pending), ConfigScheduled émet le payload, validation
  Caps (tx ≤ daily) / Strategies (program whitelisté à l'apply), deposit
  TransferChecked avec pending = delta réel reçu + check décimales
  collateral == share. Vérifié sur validateur local (tests/poc-local.ts).
- ✅ = fait dans cette session (voir commits). Phase 0 livrée : allowlist +
  simulation des deltas custody (C1), modèle d'origine + permissions +
  blind-signing blocks dans l'extension (C2/C3), circuit breakers + fee +
  caps + bigint sur le mint/redeem wrapped (H1).

- Le programme on-chain nécessite un **redéploiement** (upgrade authority) pour que Phase 1 prenne effet.
- `AGENTS.md` documente : DB Neon unique partagée, cron keeper 1 min, API Vercel.
- Déblocage d'un claim wrapped coincé : vérifier sur l'explorateur si la tx custodiale a atterri, puis `DELETE FROM wrapped_claims WHERE signature='<sig>' AND mint='<mint>'`.
