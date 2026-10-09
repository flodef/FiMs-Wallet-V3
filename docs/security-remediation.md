# Security Remediation Plan

Suivi de l'implémentation du plan de remédiation issu de l'audit de sécurité.
Demander « montre-moi le plan » ou ouvrir ce fichier pour voir l'avancement.

Légende : ⬜ à faire · ✅ fait · 🔶 partiel / action manuelle requise

## Phase 0 — Containment immédiat

- ✅ C1 — Validation des instructions yield (allowlist programId, refus SetAuthority/MintTo/Approve/CloseAccount/transfers System, simulation + vérification des deltas avant signature par la clé custodiale) — `apps/api/src/yield-placement.ts`, `apps/api/src/custodial.ts`
- ✅ C2 — Extension `signMessage` : refuser les bytes qui se décodent en tx Solana, afficher le message (UTF-8 / hexdump + warning), refuser le préfixe `fims-wallet-v3\n`, afficher compte + origine, i18n — `packages/background`, `packages/feature-request`
- ✅ C3 — Extension : capturer l'origine depuis `sender`, table de permissions par origine (connect/révocation), rejet des signatures hors origine connectée, vérif SIWS domain == origin, signer avec le compte demandé, RPC du réseau actif pour signAndSend
- ✅ H1 — `wrappedTransfer` : fraîcheur du prix (`PRICE_STALE_MS`), borne de variation vs prix précédent, fee/spread, plafonds par membre et globaux 24h, délai mint→redeem — `apps/api/src/routes/fims/http.ts`
- ✅ H1b — Confirmation `finalized` sur mint/redeem + montants en `bigint` (uiTokenAmount.amount, pas de float)
- 🔶 Séparer dev/prod (rôles Postgres moindre privilège) — action infra manuelle

## Phase 1 — Programme on-chain

- ✅ H2 — Invariants autour des CPI whitelistées : lamports / owner / data_len du vault et de `state` inchangés — `lib.rs` `cpi_whitelisted`
- ✅ H3 — `sweep` : exclure collatéral/share/position mints, plafond via spend_window ou admin-only
- ✅ H4 — `guardian_cancel_pending`, `apply_config` refusé en pause, validation `StrategyConfig`/`Caps` (tx_cap ≤ daily_cap, vaults_program whitelisté, extensions T22)
- ✅ M6 — `TransferChecked` pour dépôt, enregistrer le delta réellement reçu, vérifier décimales collateral == share, refuser extensions T22 dangereuses à la config
- 🔶 Upgrade authority + admin → multisig Squads avec timelock — action manuelle post-déploiement

## Phase 2 — API

- ⬜ H5 — Session SIWS (signature unique liée au domaine → token court) ; re-signature pour actions sensibles ; `signMessage` extension refuse le préfixe auth
- ⬜ M1 — `chainLabels` : appliquer visibilityFilter, carnet limité au propriétaire, noms réservés non usurpables
- ⬜ M2 — `deleteUser` admin-only ou soft delete ; gestion des adresses réservée à l'adresse canonique ; audit des mutations membres
- ⬜ M3 — Cap `convertPosition` dans la transaction verrouillée ; index unique `(signature, token)` donations ou claim via `used_signatures` ; 400 sur violation d'unicité
- ⬜ M4 — Custodial : machine d'états (pending → minted → recorded), job de réconciliation, sweep hors requête, `maxDuration` Vercel
- ⬜ M5 — Keeper : verrou consultatif Postgres, reprise des ops `failed`, rejet si `minOut` absent, vérif LTV on-chain
- ⬜ M9 — CSP : retirer `localhost:*` en prod, assainir les messages d'erreur (codes génériques), quotas Helius par membre

## Phase 3 — Produit, bugs, refactors

- ⬜ M7 — Enregistrement auto du carve tontine après send (vérification on-chain du delta du pot)
- ⬜ M8 — Alerte rouge bloquante pour `FIMS_DEMO_RECIPIENT` (seed publique)
- ⬜ Bug — `createVote` : double ligne d'audit admin + insertion vote/options atomique
- ⬜ Bug — `custodialBackingStatus` tient compte du backing placé en yield
- ⬜ Bug — `wrappedTransfer` : traiter tous les deltas du tx, pas le premier
- ⬜ Bug — tx soumise comme donation puis dépôt wrapped : déblocage admin
- ⬜ Bug — Commentaires custodial (NAV pas 1:1, ledger EURF/USDF)
- ⬜ Refactor — helper `requireMember`, base58/fetchInstructions/rpcCall partagés, package `fims-constants`, découpe `http.ts`, montants décimaux exacts
- ⬜ Tests — `.catch(() => {})` → logging ; i18n `feature-request` ; effets dépendant de fonctions instables

## Phase 4 — Assurance externe (manuel)

- 🔶 Audit formel (2 firmes) du programme + flux custodial
- 🔶 Fuzzing CPI comptes adversariaux, tests fork mainnet
- 🔶 Bug bounty
- 🔶 CI Rust : clippy + build-sbf + tests on-chain

## Notes

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
