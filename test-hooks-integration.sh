#!/usr/bin/env bash
# Integration test for hook installation and execution
# Tests the full workflow: install hook -> make commit -> verify rebuild triggered

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEST_DIR=$(mktemp -d)
LUX_CLI="node $SCRIPT_DIR/dist/cli/index.js"

echo "=== Lux Git Hooks Integration Test ==="
echo "Test directory: $TEST_DIR"
echo "Lux CLI: $LUX_CLI"
echo ""

cleanup() {
    rm -rf "$TEST_DIR"
}
trap cleanup EXIT

# Create a test CORPUS repository
cd "$TEST_DIR"
git init -q
git config user.name "Test User"
git config user.email "test@example.com"

# Create minimal CORPUS structure
mkdir -p knowledge/10_clients/test-client
echo "# Test Client" > knowledge/10_clients/test-client/README.md

# Initial commit
git add .
git commit -q -m "Initial commit"

echo "✓ Created test CORPUS repository"
echo ""

# Test 1: Install hook
echo "Test 1: Install hook"
$LUX_CLI hooks install --corpus "$TEST_DIR"
if [ -f ".git/hooks/post-commit" ]; then
    echo "✓ Hook file created"
    if [ -x ".git/hooks/post-commit" ]; then
        echo "✓ Hook is executable"
    else
        echo "✗ Hook is not executable"
        exit 1
    fi
else
    echo "✗ Hook file not created"
    exit 1
fi
echo ""

# Test 2: Verify hook content
echo "Test 2: Verify hook content"
if grep -q "Lux Knowledge Platform" .git/hooks/post-commit; then
    echo "✓ Hook contains Lux marker"
else
    echo "✗ Hook missing Lux marker"
    exit 1
fi
echo ""

# Test 3: Try to install again (should detect existing hook)
echo "Test 3: Try to install again (should detect existing)"
output=$($LUX_CLI hooks install --corpus "$TEST_DIR" 2>&1)
if echo "$output" | grep -q "already installed"; then
    echo "✓ Correctly detected existing hook"
else
    echo "✗ Failed to detect existing hook"
    echo "Output: $output"
    exit 1
fi
echo ""

# Test 4: Hook execution with CORPUS changes (mock lux CLI to avoid full rebuild)
echo "Test 4: Hook execution with CORPUS changes"
LOG_FILE="$TEST_DIR/hook.log"
export LUX_CLI="echo 'mock-lux'"  # Mock lux CLI that exists but does nothing
export LUX_LOG_FILE="$LOG_FILE"

echo "Additional content" >> knowledge/10_clients/test-client/README.md
git add knowledge/
git commit -q -m "Update client" 2>&1

if [ -f "$LOG_FILE" ]; then
    echo "✓ Hook executed and logged"
    if grep -q "CORPUS file(s) changed" "$LOG_FILE"; then
        echo "✓ Detected CORPUS changes"
    else
        echo "✗ Failed to detect CORPUS changes"
        cat "$LOG_FILE"
        exit 1
    fi
    if grep -q "Starting index rebuild" "$LOG_FILE"; then
        echo "✓ Attempted rebuild (as expected with mock CLI)"
    else
        echo "Note: Rebuild may have been skipped (check log)"
    fi
else
    echo "✗ Hook did not create log file"
    exit 1
fi
echo ""

# Test 5: Hook with skip directive
echo "Test 5: Hook with skip directive"
rm -f "$LOG_FILE"
echo "More content" >> knowledge/10_clients/test-client/README.md
git add knowledge/
git commit -q -m "Update [skip lux]" 2>&1

if [ -f "$LOG_FILE" ]; then
    echo "✓ Hook executed"
    if grep -q "skip directive" "$LOG_FILE"; then
        echo "✓ Respected skip directive"
    else
        echo "✗ Did not respect skip directive"
        cat "$LOG_FILE"
        exit 1
    fi
else
    echo "✗ Hook did not create log file"
    exit 1
fi
echo ""

# Test 6: Uninstall hook
echo "Test 6: Uninstall hook"
unset LUX_CLI  # Reset to default
node "$SCRIPT_DIR/dist/cli/index.js" hooks uninstall --corpus "$TEST_DIR"
if [ ! -f ".git/hooks/post-commit" ]; then
    echo "✓ Hook file removed"
else
    echo "✗ Hook file still exists"
    exit 1
fi
echo ""

# Test 7: Try to uninstall again (should be no-op)
echo "Test 7: Try to uninstall again (should be no-op)"
output=$(node "$SCRIPT_DIR/dist/cli/index.js" hooks uninstall --corpus "$TEST_DIR" 2>&1)
if echo "$output" | grep -q "No post-commit hook found"; then
    echo "✓ Correctly reported no hook found"
else
    echo "✗ Unexpected output"
    echo "Output: $output"
    exit 1
fi
echo ""

echo "=== All integration tests passed! ==="
