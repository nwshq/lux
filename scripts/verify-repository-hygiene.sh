#!/usr/bin/env bash
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"

violations=$(git ls-files | awk '
  function basename(path, parts, count) {
    count = split(path, parts, "/")
    return parts[count]
  }
  {
    name = basename($0)
    if ($0 ~ /(^|\/)\.next(\/|$)/ ||
        (name ~ /^\.env($|\.)/ && name !~ /^\.env\.example$/ && name !~ /^\.env\.sample$/ && name !~ /^\.env\.template$/)) {
      print
    }
  }
')

if [[ -n "$violations" ]]; then
  echo "Refusing tracked credentials or generated Next.js output:" >&2
  printf '  %s\n' $violations >&2
  echo "Track only sanitized .env.example/.env.sample/.env.template files; never track .next output." >&2
  exit 1
fi

echo "Repository hygiene check passed."
