import { readFile } from 'node:fs/promises';

import type { Configuration, FileSet } from 'electron-builder';
import { describe, expect, it } from 'vitest';

import { extensionTestPackagingConfig } from '../extension-test-packaging';

function source(resource: FileSet | string): string | undefined {
    return typeof resource === 'string' ? resource : resource.from;
}

describe('extension packaging profiles', () => {
    it('adds the fixture only to a separate E2E artifact', async () => {
        const manifest = JSON.parse(await readFile('package.json', 'utf8')) as {
            build: Configuration;
        };
        const productionSources = Array.isArray(manifest.build.extraResources)
            ? manifest.build.extraResources.map(source)
            : [];
        const testConfig = extensionTestPackagingConfig(manifest.build);
        const testSources = Array.isArray(testConfig.extraResources)
            ? testConfig.extraResources.map(source)
            : [];

        expect(productionSources).toContain('apps/server/dist/server');
        expect(productionSources.filter((item) => item?.startsWith('extensions/'))).toEqual([]);
        expect(testSources).toEqual(productionSources);
        expect(manifest.build.directories?.output).toBe('release.noindex');
        expect(testConfig.directories?.output).toBe('release.noindex/e2e');
    });

    it('fails closed when production packaging already contains the fixture', () => {
        expect(() => extensionTestPackagingConfig({ extraResources: [] })).toThrow(
            'Production extraResources must contain one standalone Server artifact',
        );
    });
});
