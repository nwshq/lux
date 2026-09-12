#!/usr/bin/env bash
set -euo pipefail

GITLEAKS_VERSION="8.30.1"
GITLEAKS_DARWIN_ARM64_SHA256="b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5"
GITLEAKS_LINUX_X64_SHA256="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"

# Repository content and inherited environment variables must not weaken the scanner.
for name in $(env | sed -n 's/^\(GITLEAKS_[A-Za-z0-9_]*\)=.*/\1/p'); do
  unset "$name"
done

case "$(uname -s):$(uname -m)" in
  Darwin:arm64)
    archive_name="gitleaks_${GITLEAKS_VERSION}_darwin_arm64.tar.gz"
    archive_sha256="$GITLEAKS_DARWIN_ARM64_SHA256"
    checksum_command=(shasum -a 256)
    ;;
  Linux:x86_64)
    archive_name="gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
    archive_sha256="$GITLEAKS_LINUX_X64_SHA256"
    checksum_command=(sha256sum)
    ;;
  *)
    echo "Unsupported secret-scanner platform: $(uname -s) $(uname -m)" >&2
    exit 127
    ;;
esac

temp_root=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/lux-gitleaks.XXXXXX")
trap 'rm -rf "$temp_root"' EXIT
archive="$temp_root/$archive_name"
gitleaks_bin="$temp_root/gitleaks"
curl --fail --silent --show-error --location \
  "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${archive_name}" \
  --output "$archive"
actual_sha256=$("${checksum_command[@]}" "$archive" | awk '{print $1}')
[[ "$actual_sha256" == "$archive_sha256" ]] || {
  echo "Gitleaks archive checksum verification failed." >&2
  exit 1
}
tar -xzf "$archive" -C "$temp_root" gitleaks
chmod 0755 "$gitleaks_bin"
[[ "$("$gitleaks_bin" version)" == "$GITLEAKS_VERSION" ]] || {
  echo "Refusing unpinned gitleaks version: $("$gitleaks_bin" version)" >&2
  exit 1
}

ignore_file="$temp_root/gitleaks-ignore"
: > "$ignore_file"

"$gitleaks_bin" git "$repo_root" \
  --log-opts="--all" \
  --redact=100 \
  --no-banner \
  --no-color \
  --max-archive-depth=1 \
  --config="$repo_root/config/gitleaks.toml" \
  --ignore-gitleaks-allow \
  --gitleaks-ignore-path="$ignore_file"
