import { readFile } from 'node:fs/promises';

const path = new URL('../dist/caxri.cjs', import.meta.url);
const source = await readFile(path, 'utf8');

if (!source.startsWith('#!/usr/bin/env node\n'))
    throw new Error('Standalone CLI bundle is missing its Node shebang');

const imports = [...source.matchAll(/\brequire\("([^"]+)"\)/gu)].map((match) => match[1]);
const externalImports = imports.filter((specifier) => !specifier.startsWith('node:'));
if (externalImports.length > 0)
    throw new Error(`Standalone CLI bundle has external imports: ${externalImports.join(', ')}`);

const forbiddenRuntimeMarkers = ['better-sqlite3', 'electron', 'node-pty'];
const forbiddenMarker = forbiddenRuntimeMarkers.find((marker) => source.includes(marker));
if (forbiddenMarker)
    throw new Error(`Standalone CLI bundle contains forbidden runtime marker: ${forbiddenMarker}`);

console.log(`Verified standalone CLI bundle (${Buffer.byteLength(source)} bytes)`);
