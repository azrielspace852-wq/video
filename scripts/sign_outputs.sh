#!/usr/bin/env bash
# sign_outputs.sh — Digitally sign every *.mp4 / *.zip in a directory.
#
# What it produces inside DIRECTORY:
#   <file>.mp4.sig / <file>.zip.sig   per-file ECDSA signature (detached)
#   checksums.sha256                  SHA-256 of every signed file
#   checksums.sha256.sig              signature over the checksums manifest
#   public-key.pem                    public key (verify with this)
#   verify.sh                         one-command verifier (bash verify.sh)
#   SIGNATURE-INFO.txt                human-readable signing record
#
# Usage:
#   SIGNING_PRIVATE_KEY=<pem-or-base64(pem)> SIGN_KEY_CACHE=/tmp/key.pem \
#       bash scripts/sign_outputs.sh <directory> [identity]
#
# Env:
#   SIGNING_PRIVATE_KEY  optional. PEM text, or base64(PEM). If absent/invalid
#                        an ephemeral ECDSA key is generated (integrity-only).
#   SIGN_KEY_CACHE       optional path. If set and non-empty, the key is
#                        reused across multiple invocations (same identity).
#   KEYKIND              informational label written into SIGNATURE-INFO.txt.
set -euo pipefail

DIR="${1:?usage: sign_outputs.sh <directory> [identity]}"
IDENTITY="${2:-AXION Neuralis}"
cd "$DIR"

# --- resolve / generate signing key -----------------------------------------
KEY="${SIGN_KEY_CACHE:-$(mktemp)}"
KEYKIND="${KEYKIND:-}"

if [ ! -s "$KEY" ]; then
  if [ -n "${SIGNING_PRIVATE_KEY:-}" ]; then
    if printf '%s' "$SIGNING_PRIVATE_KEY" | grep -q '^-----BEGIN'; then
      printf '%s' "$SIGNING_PRIVATE_KEY" > "$KEY"
    else
      printf '%s' "$SIGNING_PRIVATE_KEY" | base64 -d > "$KEY"
    fi
    if openssl pkey -in "$KEY" -noout 2>/dev/null; then
      KEYKIND="user-supplied trusted key"
    else
      echo "::warning::SIGNING_PRIVATE_KEY is invalid; falling back to an ephemeral key."
      openssl ecparam -genkey -name prime256v1 -noout -out "$KEY"
      KEYKIND="ephemeral (invalid user key supplied)"
    fi
  else
    openssl ecparam -genkey -name prime256v1 -noout -out "$KEY"
    KEYKIND="ephemeral CI key (integrity check only — no persistent identity)"
  fi
fi
[ -n "$KEYKIND" ] || KEYKIND="reused key"

openssl pkey -in "$KEY" -pubout -out public-key.pem
FP="$(openssl pkey -in "$KEY" -pubout -outform DER 2>/dev/null | sha256sum | cut -c1-16)"

# --- per-file detached signatures + checksums manifest ----------------------
: > checksums.sha256
FOUND=0
for f in *.mp4 *.zip; do
  [ -f "$f" ] || continue
  FOUND=$((FOUND + 1))
  sha256sum "$f" >> checksums.sha256
  openssl dgst -sha256 -sign "$KEY" -out "$f.sig" "$f"
done

if [ "$FOUND" = "0" ]; then
  echo "No .mp4 or .zip files found in $DIR; nothing to sign."
  rm -f checksums.sha256 public-key.pem
  exit 0
fi

openssl dgst -sha256 -sign "$KEY" -out checksums.sha256.sig checksums.sha256

# --- human-readable signing record ------------------------------------------
{
  echo "Digital signature — ${IDENTITY}"
  echo "Algorithm        : ECDSA (prime256v1) + SHA-256 (detached)"
  echo "Key kind         : ${KEYKIND}"
  echo "Key fingerprint  : ${FP}"
  echo "Signed at (UTC)  : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "Repository       : ${GITHUB_REPOSITORY:-n/a}"
  echo "Run URL          : ${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-n/a}"
  echo "Commit           : ${GITHUB_SHA:-n/a}"
  echo ""
  echo "Signed files (sha256):"
  sed 's/^/  /' checksums.sha256
  echo ""
  echo "Verify with: bash verify.sh"
} > SIGNATURE-INFO.txt

# --- one-command verifier ---------------------------------------------------
cat > verify.sh <<'VERIFY_EOF'
#!/usr/bin/env bash
# Verifies the digital signatures produced by sign_outputs.sh.
# Usage: bash verify.sh   (run from the folder containing public-key.pem)
set -euo pipefail
cd "$(dirname "$0")"

echo "== Verifying aggregate signature over checksums.sha256 =="
openssl dgst -sha256 -verify public-key.pem -signature checksums.sha256.sig checksums.sha256

echo "== Verifying file hashes =="
sha256sum -c checksums.sha256

echo "== Verifying per-file detached signatures =="
fail=0
while read -r hash file; do
  if [ ! -f "$file.sig" ]; then
    echo "MISSING signature: $file.sig"
    fail=1
    continue
  fi
  if openssl dgst -sha256 -verify public-key.pem -signature "$file.sig" "$file" >/dev/null 2>&1; then
    echo "OK   $file"
  else
    echo "FAIL $file"
    fail=1
  fi
done < checksums.sha256

if [ "$fail" != "0" ]; then
  echo ""
  echo "*** SIGNATURE VERIFICATION FAILED — files may be tampered with. ***"
  exit 1
fi
echo ""
echo "ALL SIGNATURES VALID — files are authentic and untampered."
VERIFY_EOF
chmod +x verify.sh

echo "Signed ${FOUND} file(s) with ${KEYKIND} (key fingerprint: ${FP})"
