import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { extensionManifestSchema } from '@caxri/protocol';
import { build } from 'vite';

import { assertExtensionBundleContract } from './extension-bundle-contract';

const extensionsRoot = resolve('extensions');

async function buildExtension(entryName: string): Promise<void> {
    const extensionRoot = join(extensionsRoot, entryName);
    const manifestPath = join(extensionRoot, 'package.json');
    let source: string;
    try {
        source = await readFile(manifestPath, 'utf8');
    } catch {
        return;
    }
    const manifest = extensionManifestSchema.parse(JSON.parse(source) as unknown);
    await build({
        configFile: false,
        build: {
            emptyOutDir: true,
            lib: {
                entry: resolve(extensionRoot, 'src/extension.ts'),
                formats: ['es'],
            },
            minify: false,
            outDir: resolve(extensionRoot, 'dist'),
            rolldownOptions: {
                external: ['caxri'],
                output: { entryFileNames: 'extension.js' },
            },
            sourcemap: true,
            ssr: true,
            target: 'node24',
        },
        logLevel: 'warn',
    });
    const outputPath = resolve(extensionRoot, 'dist/extension.js');
    assertExtensionBundleContract(await readFile(outputPath, 'utf8'), manifest.name);
    process.stdout.write(`Built ${manifest.name}\n`);
}

const extensionEntries = await readdir(extensionsRoot, { withFileTypes: true });
await Promise.all(
    extensionEntries
        .filter((entry) => entry.isDirectory())
        .map((entry) => buildExtension(entry.name)),
);
