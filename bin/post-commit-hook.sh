#!/usr/bin/env bash
# Lux Knowledge Platform - Git post-commit hook
# Automatically rebuilds index after CORPUS commits

# Exit on error
set -e

# Path to lux CLI (adjust if needed)
LUX_CLI="${LUX_CLI:-lux}"

# Only rebuild if lux is available
if ! command -v "$LUX_CLI" &> /dev/null; then
    echo "Warning: lux CLI not found. Skipping index rebuild." >&2
    exit 0
fi

# Rebuild index quietly
"$LUX_CLI" index rebuild --quiet || {
    echo "Warning: Failed to rebuild lux index" >&2
    exit 0
}

echo "✓ Lux index rebuilt" >&2
