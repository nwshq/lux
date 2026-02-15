#!/usr/bin/env node

/**
 * Test script for lux_get_file MCP tool
 *
 * Tests reading file content from CORPUS via the MCP server
 */

const { spawn } = require('child_process');
const path = require('path');

const MCP_SERVER = path.join(__dirname, 'dist', 'mcp', 'server.js');

/**
 * Send a JSON-RPC request to the MCP server and get the response
 */
function sendMCPRequest(request) {
  return new Promise((resolve, reject) => {
    const server = spawn('node', [MCP_SERVER], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    server.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    server.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    server.on('close', (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`Server exited with code ${code}\nSTDERR: ${stderr}`));
        return;
      }

      try {
        // Parse the JSON-RPC response from stdout
        const lines = stdout.trim().split('\n');
        const response = JSON.parse(lines[lines.length - 1]);
        resolve(response);
      } catch (error) {
        reject(new Error(`Failed to parse response: ${error.message}\nSTDOUT: ${stdout}`));
      }
    });

    // Send the request
    server.stdin.write(JSON.stringify(request) + '\n');
    server.stdin.end();
  });
}

async function runTests() {
  console.log('Testing lux_get_file MCP tool...\n');

  // Test 1: Get a client file
  console.log('Test 1: Read client file (acme)');
  try {
    const response1 = await sendMCPRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'lux_get_file',
        arguments: {
          file_path: path.join(process.env.HOME, 'CORPUS', 'clients', 'acme', 'CLIENT.md'),
        },
      },
    });

    if (response1.result && response1.result.content && response1.result.content[0]) {
      const content = response1.result.content[0].text;
      console.log('✓ Successfully read client file');
      console.log(`  Content preview: ${content.substring(0, 100)}...`);
      console.log(`  Content length: ${content.length} chars\n`);
    } else {
      console.log('✗ Unexpected response structure');
      console.log(JSON.stringify(response1, null, 2));
    }
  } catch (error) {
    console.log(`✗ Test failed: ${error.message}\n`);
  }

  // Test 2: Get a project file
  console.log('Test 2: Read project file (lux-knowledge-platform)');
  try {
    const response2 = await sendMCPRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'lux_get_file',
        arguments: {
          file_path: path.join(
            process.env.HOME,
            'CORPUS',
            'clients',
            'acme',
            'lux-knowledge-platform',
            'PROJECT.md'
          ),
        },
      },
    });

    if (response2.result && response2.result.content && response2.result.content[0]) {
      const content = response2.result.content[0].text;
      console.log('✓ Successfully read project file');
      console.log(`  Content preview: ${content.substring(0, 100)}...`);
      console.log(`  Content length: ${content.length} chars\n`);
    } else {
      console.log('✗ Unexpected response structure');
      console.log(JSON.stringify(response2, null, 2));
    }
  } catch (error) {
    console.log(`✗ Test failed: ${error.message}\n`);
  }

  // Test 3: Get a non-existent file (error handling)
  console.log('Test 3: Read non-existent file (should error)');
  try {
    const response3 = await sendMCPRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'lux_get_file',
        arguments: {
          file_path: '/non/existent/path/file.md',
        },
      },
    });

    if (response3.result && response3.result.isError) {
      console.log('✓ Correctly handled non-existent file');
      console.log(`  Error message: ${response3.result.content[0].text}\n`);
    } else {
      console.log('✗ Should have returned an error');
      console.log(JSON.stringify(response3, null, 2));
    }
  } catch (error) {
    console.log(`✗ Test failed: ${error.message}\n`);
  }

  // Test 4: Get a communication file
  console.log('Test 4: Read communication file (if exists)');
  try {
    const response4 = await sendMCPRequest({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'lux_get_file',
        arguments: {
          file_path: path.join(
            process.env.HOME,
            'CORPUS',
            'clients',
            'acme',
            'lux-knowledge-platform',
            'communications',
            '2025-01-20_email_lux-phase-1-completion.md'
          ),
        },
      },
    });

    if (response4.result && response4.result.content && response4.result.content[0]) {
      const content = response4.result.content[0].text;
      console.log('✓ Successfully read communication file');
      console.log(`  Content preview: ${content.substring(0, 100)}...`);
      console.log(`  Content length: ${content.length} chars\n`);
    } else if (response4.result && response4.result.isError) {
      console.log('⚠ Communication file not found (this is OK if it doesn\'t exist)');
      console.log(`  Error: ${response4.result.content[0].text}\n`);
    } else {
      console.log('✗ Unexpected response structure');
      console.log(JSON.stringify(response4, null, 2));
    }
  } catch (error) {
    console.log(`⚠ Test skipped: ${error.message}\n`);
  }

  console.log('All tests completed!');
}

runTests().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
