#!/usr/bin/env bash
# cspell:ignore Prereqs cloudkms oaep pkeyutl pubin inkey pkeyopt subarray gserviceaccount ABCDEFGHJKLMNPQRSTUVWXY Zabcdefghijkmnopqrstuvwxyz
# Provision a Google Cloud KMS Ed25519 signer for CUSTODIAL_KEYPAIR.
#
# Two paths — pick ONE:
#
#   PATH A — import the existing custodial key (recommended first step)
#     Same Solana address → zero on-chain migration, zero downtime. The key
#     leaves env vars and can only sign via KMS afterwards. Caveat: the key's
#     past exposure is unchanged — a leaked copy stays valid until the
#     authority migrates to a brand-new key (Path B later).
#
#   PATH B — generate a brand-new KMS key (real remediation)
#     New key material never seen anywhere → new Solana address. Requires
#     on-chain ops with the CURRENT custodial signer: setAuthority on both
#     wrapped mints + move the custody SOL/EURC/USDG, then cut over.
#
# Prereqs: gcloud CLI authenticated with an owner/editor account on a billing-
# enabled project, openssl. Nothing below touches prod until the LAST step.
#
# Usage:
#   PROJECT_ID=my-gcp-project LOCATION=global bash scripts/gcp-kms-provision.sh
#
# Env knobs (defaults in <...>):
#   KEYRING=fims-signers  KEY_NAME=custodial  SA_NAME=fims-api-signer
#   CUSTODIAL_KEYPAIR — required for PATH A: the 64-byte secret, JSON array or
#   base58 (same format the API env var holds today). Sourced from the current
#   Vercel secret:  bunx vercel env pull .env.prod && grep CUSTODIAL .env.prod
set -euo pipefail

PROJECT_ID=${PROJECT_ID:?"set PROJECT_ID to your billing-enabled GCP project"}
LOCATION=${LOCATION:-global}          # 'global' = geo-redundant; pick a region for residency
KEYRING=${KEYRING:-fims-signers}
KEY_NAME=${KEY_NAME:-custodial}
SA_NAME=${SA_NAME:-fims-api-signer}
IMPORT_JOB=${IMPORT_JOB:-fims-import}

KEY_RES="projects/${PROJECT_ID}/locations/${LOCATION}/keyRings/${KEYRING}/cryptoKeys/${KEY_NAME}"

echo "== 0. Enable the KMS API"
gcloud services enable cloudkms.googleapis.com --project="$PROJECT_ID"

echo "== 1. Keyring"
gcloud kms keyrings create "$KEYRING" --location="$LOCATION" --project="$PROJECT_ID" \
  || echo "(keyring already exists — continuing)"

# ---------------------------------------------------------------------------
# PATH A — import the existing custodial key (uncomment this whole block)
# ---------------------------------------------------------------------------
# echo "== 2a. Import-only cryptoKey (ec-sign-ed25519)"
# gcloud kms keys create "$KEY_NAME" \
#   --keyring="$KEYRING" --location="$LOCATION" --project="$PROJECT_ID" \
#   --purpose=asymmetric-signing --default-algorithm=ec-sign-ed25519 \
#   --import-only --skip-initial-version-creation
#
# echo "== 3a. Import job + wrapping public key"
# gcloud kms import-jobs create "$IMPORT_JOB" \
#   --keyring="$KEYRING" --location="$LOCATION" --project="$PROJECT_ID" \
#   --import-method=rsa-oaep-3072-sha256 --protection-level=software
# until gcloud kms import-jobs describe "$IMPORT_JOB" \
#     --keyring="$KEYRING" --location="$LOCATION" --project="$PROJECT_ID" \
#     --format='value(state)' | grep -q ACTIVE; do sleep 3; done
# gcloud kms import-jobs describe "$IMPORT_JOB" \
#   --keyring="$KEYRING" --location="$LOCATION" --project="$PROJECT_ID" \
#   --format='value(publicKey.pem)' > wrapping.pem
#
# echo "== 4a. Wrap the custodial seed into PKCS#8 DER"
# : "${CUSTODIAL_KEYPAIR:?export the 64-byte secret (JSON array or base58)}"
# bun -e '
#   const raw = process.env.CUSTODIAL_KEYPAIR.trim()
#   const b58="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
#   let bytes
#   if (raw.startsWith("[")) bytes = Uint8Array.from(JSON.parse(raw))
#   else { const d=[0]; for (const c of raw){let v=b58.indexOf(c),car=v;for(let i=0;i<d.length;i++){car+=(d[i]??0)*58;d[i]=car&0xff;car>>=8}while(car){d.push(car&0xff);car>>=8}}for(const c of raw){if(c!=="1")break;d.push(0)}bytes=Uint8Array.from(d.reverse()) }
#   if (bytes.length !== 64) throw new Error("expected a 64-byte keypair")
#   // Ed25519 PKCS#8 = fixed 16-byte header + the 32-byte seed
#   const der = new Uint8Array(48)
#   der.set(Buffer.from("302e020100300506032b657004220420","hex"))
#   der.set(bytes.subarray(0,32), 16)
#   require("node:fs").writeFileSync("pkcs8.der", der)
# '
# openssl pkeyutl -encrypt -pubin -inkey wrapping.pem -in pkcs8.der \
#   -out wrapped.bin -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256
#
# echo "== 5a. Import as cryptoKeyVersion 1"
# gcloud kms keys versions import \
#   --key="$KEY_NAME" --keyring="$KEYRING" --location="$LOCATION" \
#   --project="$PROJECT_ID" --algorithm=ec-sign-ed25519 \
#   --import-job="$IMPORT_JOB" --target-key-file=wrapped.bin
# rm -f pkcs8.der wrapped.bin wrapping.pem   # seed material: gone
#
# echo "== 6a. VERIFY the KMS pubkey derives to the SAME custodial address"
# gcloud kms keys versions get-public-key 1 \
#   --key="$KEY_NAME" --keyring="$KEYRING" --location="$LOCATION" \
#   --project="$PROJECT_ID" --output-file=kms-pub.pem
# DERIVED=$(bun run apps/api/scripts/gcp-kms-address.ts kms-pub.pem | tail -1)
# echo "derived address: $DERIVED  (must equal the custodial wallet's address)"
# rm -f kms-pub.pem

# ---------------------------------------------------------------------------
# PATH B — brand-new KMS key (uncomment this whole block)
# ---------------------------------------------------------------------------
# echo "== 2b. Generate the key in KMS — the seed never exists outside the HSM"
# gcloud kms keys create "$KEY_NAME" \
#   --keyring="$KEYRING" --location="$LOCATION" --project="$PROJECT_ID" \
#   --purpose=asymmetric-signing --default-algorithm=ec-sign-ed25519
#
# echo "== 3b. Derive the NEW custodial Solana address"
# gcloud kms keys versions get-public-key 1 \
#   --key="$KEY_NAME" --keyring="$KEYRING" --location="$LOCATION" \
#   --project="$PROJECT_ID" --output-file=kms-pub.pem
# NEW_ADDRESS=$(bun run apps/api/scripts/gcp-kms-address.ts kms-pub.pem | tail -1)
# echo "NEW custodial address: $NEW_ADDRESS"
# rm -f kms-pub.pem
# echo "!! MANUAL ON-CHAIN STEP — with the current custodial signer:"
# echo "!!   1. setAuthority mint-authority on both wrapped mints -> $NEW_ADDRESS"
# echo "!!   2. transfer custody SOL + EURC/USDG ATAs -> the new custody wallet"
# echo "!!   3. fund $NEW_ADDRESS with SOL for fees"
# echo "!!   Only then continue to step 4 with the env vars below."

# ---------------------------------------------------------------------------
# Shared tail: service account + Vercel env (both paths)
# ---------------------------------------------------------------------------
# echo "== 4. Least-privilege service account (sign + verify on THIS key only)"
# gcloud iam service-accounts create "$SA_NAME" --project="$PROJECT_ID" \
#   || echo "(service account already exists)"
# gcloud kms keys add-iam-policy-binding "$KEY_NAME" \
#   --keyring="$KEYRING" --location="$LOCATION" --project="$PROJECT_ID" \
#   --member="serviceAccount:${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com" \
#   --role=roles/cloudkms.signerVerifier
# gcloud iam service-accounts keys create sa-key.json \
#   --iam-account="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com" \
#   --project="$PROJECT_ID"
#
# echo "== 5. Vercel production env (run from the repo root)"
# echo "   echo gcp_kms                              | bunx vercel env add CUSTODIAL_SIGNER_BACKEND production"
# echo "   echo ${KEY_RES}/cryptoKeyVersions/1      | bunx vercel env add CUSTODIAL_GCP_KMS_KEY_NAME production"
# echo "   echo <derived-or-new-address>            | bunx vercel env add CUSTODIAL_GCP_KMS_PUBLIC_KEY production"
# echo "   jq -c . sa-key.json | tr -d '\n'          | bunx vercel env add GCP_SA_KEY_JSON production"
# echo "   bunx vercel deploy --prod     # redeploy so the env vars take effect"
# echo "   — verify one mint/burn on staging traffic —"
# echo "   bunx vercel env rm CUSTODIAL_KEYPAIR production   # only after success"
# echo "   shred -u sa-key.json                     # SA key lives in Vercel only"

echo "Nothing ran: uncomment the block matching your path (A or B) first."
