#!/bin/bash

# Test script for MCP stdio transport
# This script verifies the Lux MCP server stdio configuration

set -e

echo "🧪 Testing Lux MCP Server Stdio Transport"
echo "=========================================="
echo

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test counter
TESTS_RUN=0
TESTS_PASSED=0

run_test() {
    local test_name=$1
    local command=$2
    local expected_pattern=$3

    TESTS_RUN=$((TESTS_RUN + 1))
    echo -n "Test $TESTS_RUN: $test_name... "

    if eval "$command" 2>/dev/null | grep -q "$expected_pattern"; then
        echo -e "${GREEN}✓ PASSED${NC}"
        TESTS_PASSED=$((TESTS_PASSED + 1))
        return 0
    else
        echo -e "${RED}✗ FAILED${NC}"
        return 1
    fi
}

# Test 1: Server starts and responds
run_test "Server starts and accepts input" \
    "echo '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{}}' | node dist/mcp/server.js" \
    '"jsonrpc":"2.0"'

# Test 2: Tools list includes lux_search
run_test "Server lists lux_search tool" \
    "echo '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{}}' | node dist/mcp/server.js" \
    '"name":"lux_search"'

# Test 3: Tools list includes lux_get_client
run_test "Server lists lux_get_client tool" \
    "echo '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{}}' | node dist/mcp/server.js" \
    '"name":"lux_get_client"'

# Test 4: Tools list includes lux_log_comm
run_test "Server lists lux_log_comm tool" \
    "echo '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{}}' | node dist/mcp/server.js" \
    '"name":"lux_log_comm"'

# Test 5: Tools list includes lux_rebuild_index
run_test "Server lists lux_rebuild_index tool" \
    "echo '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{}}' | node dist/mcp/server.js" \
    '"name":"lux_rebuild_index"'

# Test 6: Server has correct capabilities
run_test "Server advertises tools capability" \
    "echo '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{}}' | node dist/mcp/server.js" \
    '"tools"'

# Test 7: Server executable has shebang
run_test "Server script has proper shebang" \
    "head -1 dist/mcp/server.js" \
    "#!/usr/bin/env node"

# Test 8: Server file is executable
if [ -x dist/mcp/server.js ]; then
    TESTS_RUN=$((TESTS_RUN + 1))
    echo -e "Test $TESTS_RUN: Server file is executable... ${GREEN}✓ PASSED${NC}"
    TESTS_PASSED=$((TESTS_PASSED + 1))
else
    TESTS_RUN=$((TESTS_RUN + 1))
    echo -e "Test $TESTS_RUN: Server file is executable... ${RED}✗ FAILED${NC}"
fi

# Summary
echo
echo "=========================================="
echo "Test Results: $TESTS_PASSED/$TESTS_RUN passed"
echo

if [ $TESTS_PASSED -eq $TESTS_RUN ]; then
    echo -e "${GREEN}✓ All tests passed!${NC}"
    echo
    echo "The stdio transport is properly configured."
    echo "You can now add the server to your MCP client configuration:"
    echo
    echo "  {\"mcpServers\": {\"lux\": {\"command\": \"node\", \"args\": [\"$(pwd)/dist/mcp/server.js\"]}}}"
    exit 0
else
    echo -e "${RED}✗ Some tests failed${NC}"
    exit 1
fi
