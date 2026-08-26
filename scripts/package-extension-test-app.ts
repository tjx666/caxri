import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { promisify } from 'node:util';

import type { Configuration } from 'electron-builder';
import { build } from 'electron-builder';

import { extensionTestPackagingConfig } from './extension-test-packaging';

const manifest = JSON.parse(await readFile('package.json', 'utf8')) as {
    build: Configuration;
};

const execFileAsync = promisify(execFile);
const artifactBuilder = 'apps/server/scripts/build-artifact.ts';

async function buildServerArtifact(shouldIncludeTestExtension: boolean): Promise<void> {
    const environment = Object.fromEntries(
        Object.entries(process.env).filter(
            ([key]) => key !== 'CAXRI_SERVER_INCLUDE_TEST_EXTENSION',
        ),
    );
    await execFileAsync(process.execPath, ['run', artifactBuilder], {
        env: shouldIncludeTestExtension
            ? { ...environment, CAXRI_SERVER_INCLUDE_TEST_EXTENSION: '1' }
            : environment,
    });
}

try {
    await buildServerArtifact(true);
    await build({
        config: extensionTestPackagingConfig(manifest.build),
        dir: true,
        mac: [],
        projectDir: process.cwd(),
    });
} finally {
    await buildServerArtifact(false);
}

process.stdout.write('Packaged the explicit E2E extension artifact under release.noindex/e2e\n');
