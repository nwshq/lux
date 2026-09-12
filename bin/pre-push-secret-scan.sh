#!/usr/bin/env bash
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
"$repo_root/scripts/verify-repository-hygiene.sh"
"$repo_root/scripts/scan-secrets.sh"
