#!/bin/bash
# Edge case tests for lux_log_event MCP tool

set -e

echo "Testing lux_log_event edge cases..."
echo

# Test 1: Empty payload object
echo "Test 1: Empty payload object"
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"lux_log_event","arguments":{"source":"edge-test","event_type":"empty_payload","summary":"Testing empty payload","payload":{}}}}' | node dist/mcp/server.js 2>/dev/null | jq '.result.content[0].text | fromjson'
echo

# Test 2: Complex nested payload
echo "Test 2: Complex nested payload structure"
echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"lux_log_event","arguments":{"source":"edge-test","event_type":"complex_payload","summary":"Testing complex nested payload","payload":{"array":[1,2,3],"nested":{"deep":{"value":"test"}},"boolean":true,"null_value":null}}}}' | node dist/mcp/server.js 2>/dev/null | jq '.result.content[0].text | fromjson'
echo

# Test 3: Very long summary
echo "Test 3: Very long summary string"
LONG_SUMMARY="This is a very long summary that contains a lot of text to test how the system handles longer descriptions of events that might span multiple lines and contain detailed information about what happened during the execution of a particular operation or workflow step in the Lux Knowledge Platform."
echo "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"lux_log_event\",\"arguments\":{\"source\":\"edge-test\",\"event_type\":\"long_summary\",\"summary\":\"$LONG_SUMMARY\"}}}" | node dist/mcp/server.js 2>/dev/null | jq '.result.content[0].text | fromjson'
echo

# Test 4: Special characters in strings
echo "Test 4: Special characters in summary and payload"
echo '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"lux_log_event","arguments":{"source":"edge-test","event_type":"special_chars","summary":"Testing special chars: \"quotes\", '\''apostrophes'\'', & ampersands","payload":{"special":"<tag>","unicode":"🎉✨"}}}}' | node dist/mcp/server.js 2>/dev/null | jq '.result.content[0].text | fromjson'
echo

# Test 5: Project without client (should fail gracefully)
echo "Test 5: Project slug without client slug (should log without associations)"
echo '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"lux_log_event","arguments":{"source":"edge-test","event_type":"orphan_project","summary":"Testing project without client","project_slug":"some-project"}}}' | node dist/mcp/server.js 2>/dev/null | jq '.result.content[0].text | fromjson'
echo

# Test 6: Numeric values in strings (common mistake)
echo "Test 6: Ensuring string types are preserved"
echo '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"lux_log_event","arguments":{"source":"edge-test","event_type":"type_test","summary":"Testing type preservation","payload":{"string_number":"123","actual_number":456,"zero":0,"empty_string":""}}}}' | node dist/mcp/server.js 2>/dev/null | jq '.result.content[0].text | fromjson'
echo

echo "All edge case tests completed!"
