/**
 * The public CI log safety contract reads every tracked or untracked executable source at runtime, so this one
 * definition of its scan scope serves both the test and the changed-file check that has to select it.
 */
export const CI_E2E_LOG_SAFETY_TEST = 'scripts/__tests__/ci-e2e-log-safety.test.ts';

const EXECUTABLE_SOURCE =
    /(?:^|\/)(?:[^/]+\.(?:cjs|js|json|mjs|sh|toml|ts|tsx|yaml|yml)|Dockerfile)$/u;

function isTestSource(path: string): boolean {
    return path.includes('/__tests__/') || /(?:^|\/)[^/]+\.(?:spec|test)\.[^/]+$/u.test(path);
}

/**
 * Whether the log safety contract scans this repository-relative path.
 */
export function isCiE2ELogSafetyScanPath(path: string): boolean {
    return EXECUTABLE_SOURCE.test(path) && !isTestSource(path);
}
