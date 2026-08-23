import type { Configuration, FileSet } from 'electron-builder';

export const testOnlyExtensionResource = {
    from: 'extensions/fixture',
    to: 'extensions/fixture',
    filter: ['package.json', 'dist/**', 'media/**'],
} as const satisfies FileSet;

function resourceSource(resource: FileSet | string): string | undefined {
    return typeof resource === 'string' ? resource : resource.from;
}

/**
 * Produces a separate packaged E2E artifact without mutating the production app. Runtime filtering remains defense in
 * depth; the production artifact boundary is the absence of this test-only resource.
 */
export function extensionTestPackagingConfig(build: Configuration): Configuration {
    if (!Array.isArray(build.extraResources))
        throw new Error('Production extraResources must be an explicit array');
    if (build.extraResources.some((resource) => resourceSource(resource) === 'extensions/fixture'))
        throw new Error('Production extraResources already contain the test-only extension');

    return {
        directories: { output: 'release.noindex/e2e' },
        extraResources: [...build.extraResources, testOnlyExtensionResource],
    };
}
