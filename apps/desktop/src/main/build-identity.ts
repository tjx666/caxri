import process from 'node:process';

/**
 * Stamps the build's version and commit into the environment before anything logs, so Server and Desktop records
 * correlate to this build; see `global.d.ts` and `electron.vite.config.ts` for the injected constants. Returns the
 * version for the update service and diagnostics.
 */
export function stampBuildIdentity(): string {
    const version = typeof __CAXRI_VERSION__ === 'string' ? __CAXRI_VERSION__ : 'unknown';
    process.env.CAXRI_APP_VERSION = version;
    process.env.CAXRI_GIT_COMMIT =
        typeof __CAXRI_COMMIT__ === 'string' ? __CAXRI_COMMIT__ : 'unknown';
    return version;
}
