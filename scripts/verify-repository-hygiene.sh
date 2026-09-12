#!/usr/bin/env bash
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"

status=0
while IFS= read -r -d '' path; do
  name=${path##*/}
  if [[ "$path" =~ (^|/)\.next(/|$) ]] || {
    [[ "$name" =~ ^\.env($|\.) ]] &&
      [[ "$name" != .env.example ]] &&
      [[ "$name" != .env.sample ]] &&
      [[ "$name" != .env.template ]]
  }; then
    if [[ $status -eq 0 ]]; then
      echo "Refusing tracked credentials or generated Next.js output:" >&2
    fi
    printf '  %q\n' "$path" >&2
    status=1
  fi
done < <(git ls-files -z)

if [[ $status -ne 0 ]]; then
  echo "Track only sanitized .env.example/.env.sample/.env.template files; never track .next output." >&2
  exit "$status"
fi

echo "Repository hygiene check passed."
