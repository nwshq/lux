#!/usr/bin/env node

/**
 * Simple test for lux_get_file MCP tool
 * Creates a temp file and reads it back
 */

const { spawn } = require('child_process');
const { writeFileSync, mkdirSync, unlinkSync, rmdirSync } = require('fs');
const path = require('path');

const MCP_SERVER = path.join(__dirname, 'dist', 'mcp', 'server.js');
const TEST_DIR = path.join(__dirname, 'test-temp');
const TEST_FILE = path.join(TEST_DIR, 'test-file.md');

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
        const lines = stdout.trim().split('\n');
        const response = JSON.parse(lines[lines.length - 1]);
        resolve(response);
      } catch (error) {
        reject(new Error(`Failed to parse response: ${error.message}\nSTDOUT: ${stdout}`));
      }
    });

    server.stdin.write(JSON.stringify(request) + '\n');
    server.stdin.end();
  });
}

async function runTest() {
  console.log('Testing lux_get_file MCP tool with temp file...\n');

  // Setup: Create test file
  mkdirSync(TEST_DIR, { recursive: true });
  const testContent = `---
title: Test Document
type: test
---

# Test Content

This is a test markdown file for verifying lux_get_file functionality.

## Features

- Frontmatter parsing
- Markdown content
- File reading via MCP
`;

  writeFileSync(TEST_FILE, testContent, 'utf-8');
  console.log(`Created test file: ${TEST_FILE}\n`);

  try {
    // Test: Read the file
    console.log('Test: Read test file via lux_get_file');
    const response = await sendMCPRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'lux_get_file',
        arguments: {
          file_path: TEST_FILE,
        },
      },
    });

    if (response.result && response.result.content && response.result.content[0]) {
      const content = response.result.content[0].text;

      if (content === testContent) {
        console.log('✓ SUCCESS: File content matches exactly');
        console.log(`  File size: ${content.length} bytes`);
        console.log(`  Has frontmatter: ${content.includes('---')}`);
        console.log(`  Has markdown content: ${content.includes('# Test Content')}`);
      } else {
        console.log('✗ FAIL: Content mismatch');
        console.log('Expected:', testContent);
        console.log('Got:', content);
      }
    } else if (response.result && response.result.isError) {
      console.log('✗ FAIL: Received error response');
      console.log('Error:', response.result.content[0].text);
    } else {
      console.log('✗ FAIL: Unexpected response structure');
      console.log(JSON.stringify(response, null, 2));
    }
  } catch (error) {
    console.log(`✗ FAIL: ${error.message}`);
  } finally {
    // Cleanup
    try {
      unlinkSync(TEST_FILE);
      rmdirSync(TEST_DIR);
      console.log('\nCleaned up test files');
    } catch (error) {
      console.log(`\nWarning: Cleanup failed: ${error.message}`);
    }
  }
}

runTest().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
