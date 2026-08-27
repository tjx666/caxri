import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';

import { extensionManifestSchema } from '@caxri/protocol';
import { build } from 'vite';

import {
    assertExtensionBundleContract,
    assertProductExtensionBundleContract,
} from './extension-bundle-contract';

const { values } = parseArgs({
    options: { 'extension-root': { type: 'string' } },
    strict: true,
});
if (!values['extension-root']) throw new Error('--extension-root is required');

const extensionRoot = resolve(values['extension-root']);
const manifestPath = resolve(extensionRoot, 'package.json');
const manifest = extensionManifestSchema.parse(
    JSON.parse(await readFile(manifestPath, 'utf8')) as unknown,
);

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
        sourcemap: false,
        ssr: true,
        target: 'node24',
    },
    logLevel: 'warn',
});

const outputPath = resolve(extensionRoot, 'dist/extension.js');
const bundle = await readFile(outputPath, 'utf8');
if (manifest.caxri.testOnly) assertExtensionBundleContract(bundle, manifest.name);
else assertProductExtensionBundleContract(bundle, manifest.name);
process.stdout.write(`Built ${manifest.name}\n`);
