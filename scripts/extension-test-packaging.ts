import type { Configuration, FileSet } from 'electron-builder';

function resourceSource(resource: FileSet | string): string | undefined {
    return typeof resource === 'string' ? resource : resource.from;
}

/**
 * Produces a separate packaged E2E destination. The packaging runner first rebuilds the Server artifact with the
 * fixture so its immutable manifest covers the test-only extension, then restores the production artifact.
 */
export function extensionTestPackagingConfig(build: Configuration): Configuration {
    if (!Array.isArray(build.extraResources))
        throw new Error('Production extraResources must be an explicit array');
    if (
        build.extraResources.filter(
            (resource) => resourceSource(resource) === 'apps/server/dist/server',
        ).length !== 1
    ) {
        throw new Error('Production extraResources must contain one standalone Server artifact');
    }

    return {
        directories: { output: 'release.noindex/e2e' },
        extraResources: build.extraResources,
    };
}
