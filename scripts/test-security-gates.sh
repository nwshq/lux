#!/usr/bin/env bash
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
temp_root=$(mktemp -d "${TMPDIR:-/tmp}/lux-security-gates.XXXXXX")
trap 'rm -rf "$temp_root"' EXIT

new_fixture() {
  local name=$1
  local fixture="$temp_root/$name"
  mkdir -p "$fixture/scripts" "$fixture/config"
  cp "$repo_root/scripts/verify-repository-hygiene.sh" "$fixture/scripts/"
  cp "$repo_root/scripts/scan-secrets.sh" "$fixture/scripts/"
  cp "$repo_root/config/gitleaks.toml" "$fixture/config/"
  git -C "$fixture" init -q
  git -C "$fixture" config core.hooksPath /dev/null
  git -C "$fixture" config user.name "Security Gate Test"
  git -C "$fixture" config user.email "security-gate@example.invalid"
  printf '%s\n' "$fixture"
}

expect_failure() {
  local label=$1
  shift
  if "$@" >"$temp_root/$label.stdout" 2>"$temp_root/$label.stderr"; then
    echo "Expected $label to fail, but it passed." >&2
    exit 1
  fi
}

# Sanitized templates remain legal.
fixture=$(new_fixture allowed-templates)
touch "$fixture/.env.example" "$fixture/.env.sample" "$fixture/.env.template"
git -C "$fixture" add .
git -C "$fixture" commit -qm "test: allowed templates"
(cd "$fixture" && bash scripts/verify-repository-hygiene.sh) >/dev/null

# Force-tracked nested environment files and Next.js output fail deterministically.
fixture=$(new_fixture prohibited-paths)
mkdir -p "$fixture/nested/app/.next"
printf 'TOKEN=synthetic\n' > "$fixture/nested/app/.env.production"
printf '{}\n' > "$fixture/nested/app/.next/manifest.json"
git -C "$fixture" add -f .
git -C "$fixture" commit -qm "test: prohibited generated paths"
expect_failure prohibited-paths bash -c "cd \"$fixture\" && bash scripts/verify-repository-hygiene.sh"

# A synthetic high-entropy generic key must be detected even when repository and
# environment suppression surfaces attempt to disable scanning.
fixture=$(new_fixture suppression-resistance)
canary=$(printf 'lux-security-gate-canary' | shasum -a 256 | awk '{print $1}')
printf 'API_KEY = "%s" # gitleaks:allow\n' "$canary" > "$fixture/fixture.txt"
cat > "$fixture/.gitleaks.toml" <<'TOML'
title = "malicious local override"
[[allowlists]]
description = "must not suppress the controlled scanner"
paths = ['''.*''']
TOML
printf 'not-a-valid-fingerprint\n' > "$fixture/.gitleaksignore"
git -C "$fixture" add .
git -C "$fixture" commit -qm "test: suppression resistance"
set +e
GITLEAKS_CONFIG_TOML=$'[extend]\nuseDefault = false' \
  bash -c "cd \"$fixture\" && bash scripts/scan-secrets.sh" \
  >"$temp_root/suppression-resistance.stdout" \
  2>"$temp_root/suppression-resistance.stderr"
scan_status=$?
set -e
[[ $scan_status -ne 0 ]] || { echo "Suppressed synthetic secret escaped detection." >&2; exit 1; }
if grep -Fq "$canary" "$temp_root/suppression-resistance.stdout" "$temp_root/suppression-resistance.stderr"; then
  echo "Secret scanner output was not fully redacted." >&2
  exit 1
fi

echo "Security gate mutation tests passed."
