#!/bin/bash
# Test script for lux_log_event MCP tool

set -e

echo "Testing lux_log_event MCP tool..."
echo

# Test 1: Basic event logging
echo "Test 1: Basic event logging with minimal parameters"
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"lux_log_event","arguments":{"source":"test","event_type":"unit_test","summary":"Testing lux_log_event tool"}}}' | node dist/mcp/server.js 2>/dev/null | jq '.result.content[0].text | fromjson'
echo

# Test 2: Event logging with client context
echo "Test 2: Event logging with client context"
echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"lux_log_event","arguments":{"source":"test","event_type":"client_activity","summary":"Testing with client context","client_slug":"acme"}}}' | node dist/mcp/server.js 2>/dev/null | jq '.result.content[0].text | fromjson'
echo

# Test 3: Event logging with client and project context
echo "Test 3: Event logging with client and project context"
echo '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"lux_log_event","arguments":{"source":"test","event_type":"project_activity","summary":"Testing with project context","client_slug":"acme","project_slug":"lux-knowledge-platform"}}}' | node dist/mcp/server.js 2>/dev/null | jq '.result.content[0].text | fromjson'
echo

# Test 4: Event logging with payload
echo "Test 4: Event logging with custom payload"
echo '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"lux_log_event","arguments":{"source":"test","event_type":"custom_event","summary":"Testing with payload","payload":{"key1":"value1","key2":42,"nested":{"foo":"bar"}}}}}' | node dist/mcp/server.js 2>/dev/null | jq '.result.content[0].text | fromjson'
echo

# Test 5: Event logging with nonexistent client (should still work, just without client_id)
echo "Test 5: Event logging with nonexistent client (should still work)"
echo '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"lux_log_event","arguments":{"source":"test","event_type":"test_event","summary":"Testing with invalid client","client_slug":"nonexistent-client"}}}' | node dist/mcp/server.js 2>/dev/null | jq '.result.content[0].text | fromjson'
echo

echo "All tests completed successfully!"
echo
echo "Verifying events were logged to database..."
node -e "
const { LuxDatabase } = require('./dist/db/index.js');
const { join } = require('path');
const { homedir } = require('os');

const db = new LuxDatabase(join(homedir(), '.lux', 'lux.db'));
const events = db.getRecentEvents(10);
console.log('\nRecent events in database:');
events.filter(e => e.source === 'test').forEach(e => {
  console.log(\`- [\${e.event_type}] \${e.summary} (timestamp: \${e.timestamp})\`);
});
db.close();
"
