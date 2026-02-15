#!/bin/bash

# Test script for lux_list_projects MCP tool
# This script verifies the lux_list_projects tool functionality

set -e

echo "🧪 Testing lux_list_projects MCP Tool"
echo "======================================"
echo

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
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

    local result=$(eval "$command" 2>&1)

    # Filter out the "Lux MCP server running" stderr message
    result=$(echo "$result" | grep -v "Lux MCP server running")

    if echo "$result" | grep -q "$expected_pattern"; then
        echo -e "${GREEN}✓ PASSED${NC}"
        TESTS_PASSED=$((TESTS_PASSED + 1))
        return 0
    else
        echo -e "${RED}✗ FAILED${NC}"
        echo -e "${YELLOW}Expected pattern: $expected_pattern${NC}"
        echo -e "${YELLOW}Got:${NC}"
        echo "$result" | head -20
        return 1
    fi
}

# Ensure the server is built
if [ ! -f "dist/mcp/server.js" ]; then
    echo -e "${RED}Error: dist/mcp/server.js not found. Run 'npm run build' first.${NC}"
    exit 1
fi

# Test 1: Tool is listed in available tools
run_test "lux_list_projects is available in tool list" \
    "echo '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{}}' | node dist/mcp/server.js" \
    '"name":"lux_list_projects"'

# Test 2: Tool description is correct
run_test "lux_list_projects has correct description" \
    "echo '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{}}' | node dist/mcp/server.js" \
    '"description":"List all projects for a given client."'

# Test 3: Tool has client_slug parameter
run_test "lux_list_projects requires client_slug parameter" \
    "echo '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{}}' | node dist/mcp/server.js" \
    '"client_slug"'

# Test 4: Call with non-existent client returns error
run_test "Returns error for non-existent client" \
    "echo '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"lux_list_projects\",\"arguments\":{\"client_slug\":\"nonexistent-client-xyz\"}}}' | node dist/mcp/server.js" \
    'Client not found'

# Test 5: Check if database has any clients (for functional test)
echo
echo -e "${BLUE}Checking for available clients in database...${NC}"
DB_PATH="${HOME}/.lux/lux.db"

if [ ! -f "$DB_PATH" ]; then
    echo -e "${YELLOW}Warning: Database not found at $DB_PATH${NC}"
    echo -e "${YELLOW}Run 'lux index rebuild' or 'lux_rebuild_index' to populate the database${NC}"
    echo
else
    # Try to get a real client from the database
    REAL_CLIENT=$(sqlite3 "$DB_PATH" "SELECT slug FROM clients LIMIT 1" 2>/dev/null || echo "")

    if [ -n "$REAL_CLIENT" ]; then
        echo -e "${GREEN}Found client: $REAL_CLIENT${NC}"
        echo

        # Test 6: Call with real client slug
        run_test "Successfully lists projects for real client ($REAL_CLIENT)" \
            "echo '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"lux_list_projects\",\"arguments\":{\"client_slug\":\"$REAL_CLIENT\"}}}' | node dist/mcp/server.js" \
            '"result"'

        # Test 7: Response is valid JSON array
        run_test "Response contains JSON array" \
            "echo '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"lux_list_projects\",\"arguments\":{\"client_slug\":\"$REAL_CLIENT\"}}}' | node dist/mcp/server.js" \
            '\['

        # Test 8: Display actual response (informational)
        echo
        echo -e "${BLUE}Sample response for client '$REAL_CLIENT':${NC}"
        echo '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"lux_list_projects\",\"arguments\":{\"client_slug\":\"'"$REAL_CLIENT"'\"}}}' | \
            node dist/mcp/server.js 2>&1 | \
            grep -o '"result":{[^}]*"content":\[[^]]*\]' | \
            head -5
        echo
    else
        echo -e "${YELLOW}No clients found in database${NC}"
        echo -e "${YELLOW}Skipping functional tests with real data${NC}"
        echo
    fi
fi

# Summary
echo
echo "======================================"
echo "Test Results: $TESTS_PASSED/$TESTS_RUN passed"
echo

if [ $TESTS_PASSED -eq $TESTS_RUN ]; then
    echo -e "${GREEN}✓ All tests passed!${NC}"
    echo
    echo "The lux_list_projects tool is working correctly."
    echo
    echo "Usage example:"
    echo '  {"name": "lux_list_projects", "arguments": {"client_slug": "your-client"}}'
    exit 0
else
    echo -e "${RED}✗ Some tests failed${NC}"
    exit 1
fi
