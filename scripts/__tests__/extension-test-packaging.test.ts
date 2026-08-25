import { readFile } from 'node:fs/promises';

import type { Configuration, FileSet } from 'electron-builder';
import { describe, expect, it } from 'vitest';

import {
    extensionTestPackagingConfig,
    testOnlyExtensionResource,
} from '../extension-test-packaging';

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

        expect(productionSources.filter((item) => item?.startsWith('extensions/'))).toEqual([
            'extensions/git',
            'extensions/status',
        ]);
        expect(testSources).toEqual([...productionSources, testOnlyExtensionResource.from]);
        expect(manifest.build.directories?.output).toBe('release.noindex');
        expect(testConfig.directories?.output).toBe('release.noindex/e2e');
    });

    it('fails closed when production packaging already contains the fixture', () => {
        expect(() =>
            extensionTestPackagingConfig({ extraResources: [testOnlyExtensionResource] }),
        ).toThrow('Production extraResources already contain the test-only extension');
    });
});
