import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';

export function verifyBundleSource(source: string): number {
    if (!source.startsWith('#!/usr/bin/env node\n'))
        throw new Error('Standalone CLI bundle is missing its Node shebang');

    const imports = source
        .matchAll(/\brequire\("([^"]+)"\)/gu)
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
    console.log(`Verified standalone CLI bundle (${verifyBundleSource(source)} bytes)`);
}

if (import.meta.main) await verifyBundleFile();
