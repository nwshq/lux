#!/usr/bin/env bash
# Test script for post-commit-hook.sh
# Tests various scenarios for commit detection and rebuild triggering

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEST_DIR=$(mktemp -d)
HOOK_SCRIPT="$SCRIPT_DIR/bin/post-commit-hook.sh"

echo "Test directory: $TEST_DIR"
echo "Hook script: $HOOK_SCRIPT"
echo ""

cleanup() {
    rm -rf "$TEST_DIR"
}
trap cleanup EXIT

# Create a minimal git repo
cd "$TEST_DIR"
git init -q
git config user.name "Test User"
git config user.email "test@example.com"

# Create CORPUS-like structure
mkdir -p knowledge/10_clients/test-client
mkdir -p explorations
mkdir -p implementation-payloads
mkdir -p other-dir

# Test 1: Commit with CORPUS changes
echo "Test 1: Commit with knowledge/ changes (should trigger rebuild)"
echo "test content" > knowledge/10_clients/test-client/README.md
git add knowledge/
git commit -q -m "Add test client"

# Simulate hook execution
export LUX_CLI="echo lux"  # Mock lux CLI
export LUX_LOG_FILE="$TEST_DIR/hook.log"
bash "$HOOK_SCRIPT"
if [ -f "$LUX_LOG_FILE" ]; then
    echo "✓ Hook executed with logging"
    grep -q "CORPUS file(s) changed" "$LUX_LOG_FILE" && echo "✓ Detected CORPUS changes" || echo "✗ Failed to detect changes"
else
    echo "✗ No log file created"
fi
echo ""

# Test 2: Commit without CORPUS changes
echo "Test 2: Commit without CORPUS changes (should skip rebuild)"
rm -f "$LUX_LOG_FILE"
echo "other content" > other-dir/file.txt
git add other-dir/
git commit -q -m "Add non-CORPUS file"

bash "$HOOK_SCRIPT"
if [ -f "$LUX_LOG_FILE" ]; then
    grep -q "No CORPUS content changes detected" "$LUX_LOG_FILE" && echo "✓ Correctly skipped rebuild" || echo "✗ Unexpected behavior"
else
    echo "✗ No log file created"
fi
echo ""

# Test 3: Commit with [skip lux] tag
echo "Test 3: Commit with [skip lux] directive (should skip rebuild)"
rm -f "$LUX_LOG_FILE"
echo "test update" >> knowledge/10_clients/test-client/README.md
git add knowledge/
git commit -q -m "Update client [skip lux]"

bash "$HOOK_SCRIPT"
if [ -f "$LUX_LOG_FILE" ]; then
    grep -q "commit message contains skip directive" "$LUX_LOG_FILE" && echo "✓ Correctly skipped via commit message" || echo "✗ Failed to detect skip directive"
else
    echo "✗ No log file created"
fi
echo ""

# Test 4: LUX_SKIP_REBUILD environment variable
echo "Test 4: LUX_SKIP_REBUILD=1 (should skip rebuild)"
rm -f "$LUX_LOG_FILE"
echo "another update" >> knowledge/10_clients/test-client/README.md
git add knowledge/
git commit -q -m "Update client again"

export LUX_SKIP_REBUILD=1
bash "$HOOK_SCRIPT"
if [ -f "$LUX_LOG_FILE" ]; then
    grep -q "LUX_SKIP_REBUILD is set" "$LUX_LOG_FILE" && echo "✓ Correctly skipped via env var" || echo "✗ Failed to detect env var"
else
    echo "✗ No log file created"
fi
unset LUX_SKIP_REBUILD
echo ""

# Test 5: Missing lux CLI
echo "Test 5: Missing lux CLI (should gracefully skip)"
rm -f "$LUX_LOG_FILE"
echo "yet another update" >> knowledge/10_clients/test-client/README.md
git add knowledge/
git commit -q -m "Update client yet again"

export LUX_CLI="nonexistent-lux-command"
bash "$HOOK_SCRIPT"
if [ -f "$LUX_LOG_FILE" ]; then
    grep -q "lux CLI not found" "$LUX_LOG_FILE" && echo "✓ Correctly handled missing CLI" || echo "✗ Failed to handle missing CLI"
else
    echo "✗ No log file created"
fi
echo ""

# Test 6: Exploration directory changes
echo "Test 6: Changes to explorations/ (should trigger rebuild)"
rm -f "$LUX_LOG_FILE"
export LUX_CLI="echo lux"
echo "exploration content" > explorations/test-exploration.md
git add explorations/
git commit -q -m "Add exploration"

bash "$HOOK_SCRIPT"
if [ -f "$LUX_LOG_FILE" ]; then
    grep -q "CORPUS file(s) changed" "$LUX_LOG_FILE" && echo "✓ Detected explorations/ changes" || echo "✗ Failed to detect changes"
else
    echo "✗ No log file created"
fi
echo ""

echo "All tests completed!"
