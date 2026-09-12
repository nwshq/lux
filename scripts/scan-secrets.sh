#!/usr/bin/env bash
set -euo pipefail

GITLEAKS_VERSION="8.30.1"
GITLEAKS_LINUX_X64_SHA256="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
repo_root=$(git rev-parse --show-toplevel)

if command -v gitleaks >/dev/null 2>&1 && [[ "$(gitleaks version)" == "$GITLEAKS_VERSION" ]]; then
  gitleaks_bin=$(command -v gitleaks)
elif [[ "${RUNNER_OS:-}" == "Linux" && "$(uname -m)" == "x86_64" ]]; then
  cache_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/lux-gitleaks-${GITLEAKS_VERSION}"
  archive="$cache_root/gitleaks.tar.gz"
  gitleaks_bin="$cache_root/gitleaks"
  mkdir -p "$cache_root"
  if [[ ! -x "$gitleaks_bin" ]]; then
    curl --fail --silent --show-error --location \
      "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" \
      --output "$archive"
    printf '%s  %s\n' "$GITLEAKS_LINUX_X64_SHA256" "$archive" | sha256sum --check --status
    tar -xzf "$archive" -C "$cache_root" gitleaks
    chmod 0755 "$gitleaks_bin"
  fi
else
  installed_version="not installed"
  command -v gitleaks >/dev/null 2>&1 && installed_version=$(gitleaks version)
  echo "gitleaks ${GITLEAKS_VERSION} is required; found ${installed_version}." >&2
  exit 127
fi

[[ "$("$gitleaks_bin" version)" == "$GITLEAKS_VERSION" ]] || {
  echo "Refusing unpinned gitleaks version: $("$gitleaks_bin" version)" >&2
  exit 1
}

exec "$gitleaks_bin" git "$repo_root" \
  --log-opts="--all" \
  --redact=100 \
  --no-banner \
  --no-color \
  --max-archive-depth=1
