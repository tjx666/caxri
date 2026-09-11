import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export function verifyBundleSource(source: string): number {
    if (!source.startsWith('#!/usr/bin/env node\n'))
        throw new Error('Standalone CLI bundle is missing its Node shebang');

    const imports = source
        .matchAll(/\brequire\d*\("([^"]+)"\)/gu)
        .map((match) => match[1])
        .toArray();
    const externalImports = imports.filter((specifier) => !isBuiltin(specifier));
    if (externalImports.length > 0)
        throw new Error(
            `Standalone CLI bundle has external imports: ${externalImports.join(', ')}`,
        );

    const forbiddenRuntimeMarkers = ['better-sqlite3', 'electron', 'node-pty'];
    const forbiddenMarker = forbiddenRuntimeMarkers.find((marker) => source.includes(marker));
    if (forbiddenMarker)
        throw new Error(
            `Standalone CLI bundle contains forbidden runtime marker: ${forbiddenMarker}`,
        );

    for (const skillMarker of ['name: caxri-cli', 'Start with live introspection']) {
        if (!source.includes(skillMarker))
            throw new Error(
                `Standalone CLI bundle is missing bundled skill marker: ${skillMarker}`,
            );
    }

    return Buffer.byteLength(source);
}

async function verifyBundleFile(): Promise<void> {
    const path = new URL('../dist/caxri.cjs', import.meta.url);
    const source = await readFile(path, 'utf8');
    const bytes = verifyBundleSource(source);
    /**
     * Exercise Node import evaluation: syntactically bundled UMD code can still retain hidden dynamic imports.
     */
    await promisify(execFile)('node', [fileURLToPath(path), '--version'], { timeout: 5_000 });
    console.log(`Verified standalone CLI bundle (${bytes} bytes)`);
}

if (import.meta.main) await verifyBundleFile();
