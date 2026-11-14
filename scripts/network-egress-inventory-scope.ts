/**
 * The network egress inventory scans Electron Main, Server Core, and the shared system package at runtime instead of
 * importing them, so this one definition of its scan scope serves both the test and the changed-file check that has to
 * select it. A private method named `fetch` once passed the local check and failed only in the `guards` job.
 */
export const NETWORK_EGRESS_INVENTORY_TEST = 'scripts/__tests__/network-egress-inventory.test.ts';

/**
 * The document whose outbound-request entries the inventory checks against.
 */
export const NETWORK_EGRESS_SECURITY_DOC =
    '.agents/skills/project-architecture/references/security.md';

/**
 * Source roots the inventory scans for request call sites.
 */
export const NETWORK_EGRESS_SCANNED_ROOTS = [
    'apps/desktop/src/main',
    'apps/server/src',
    'packages/system/src',
] as const;

/**
 * Whether a repository-relative path is a test file the inventory skips.
 */
export function isNetworkEgressTestPath(path: string): boolean {
    return /(?:^|\/)__tests__\/|\.test\.tsx?$/u.test(path);
}

/**
 * Whether a change to this repository-relative path can change the inventory's result.
 */
export function isNetworkEgressScanPath(path: string): boolean {
    if (path === NETWORK_EGRESS_SECURITY_DOC) return true;
    if (!/\.tsx?$/u.test(path) || isNetworkEgressTestPath(path)) return false;
    return NETWORK_EGRESS_SCANNED_ROOTS.some((root) => path.startsWith(`${root}/`));
}
