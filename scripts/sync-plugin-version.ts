#!/usr/bin/env npx tsx

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname ?? '.', '..');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  version: string;
};
const pluginPath = resolve(root, 'plugin.json');
const plugin = JSON.parse(readFileSync(pluginPath, 'utf8')) as Record<string, unknown>;

plugin.version = packageJson.version;
writeFileSync(pluginPath, `${JSON.stringify(plugin, null, 2)}\n`);
