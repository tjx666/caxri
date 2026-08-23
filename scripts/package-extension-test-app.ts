import { readFile } from 'node:fs/promises';
import process from 'node:process';

import type { Configuration } from 'electron-builder';
import { build } from 'electron-builder';

import { extensionTestPackagingConfig } from './extension-test-packaging';

const manifest = JSON.parse(await readFile('package.json', 'utf8')) as {
    build: Configuration;
};

await build({
    config: extensionTestPackagingConfig(manifest.build),
    dir: true,
    mac: [],
    projectDir: process.cwd(),
});

process.stdout.write('Packaged the explicit E2E extension artifact under release.noindex/e2e\n');
