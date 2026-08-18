/**
 * Build identity of one side of the Desktop↔Host attachment. Fields are compared only when both sides report a real
 * value; `undefined` and the `'unknown'` build-time fallback mean "cannot tell", never "different".
 */
export interface HostBuildIdentity {
    buildId?: string;
    commit?: string;
    version?: string;
}

function knownValue(value: string | undefined): string | undefined {
    return value && value !== 'unknown' ? value : undefined;
}

/**
 * Decides whether a discovered Host process was built from different code than the connecting Desktop and must be
 * replaced before serving requests. A detached Host survives Desktop restarts, so after a rebuild (dev) or an app
 * upgrade (packaged) the adopted Host can silently keep running an older build — exactly the failure this check
 * closes.
 *
 * The per-build `buildId` is authoritative when both sides carry one: it is the only identity that distinguishes two
 * dev builds of the same (possibly dirty) checkout, where version and commit are identical. Version/commit remain as
 * the fallback for Hosts built before the buildId existed.
 */
export function isHostBuildStale(desktop: HostBuildIdentity, host: HostBuildIdentity): boolean {
    const desktopBuildId = knownValue(desktop.buildId);
    const hostBuildId = knownValue(host.buildId);
    if (desktopBuildId && hostBuildId) return desktopBuildId !== hostBuildId;
    const desktopVersion = knownValue(desktop.version);
    const hostVersion = knownValue(host.version);
    if (desktopVersion && hostVersion && desktopVersion !== hostVersion) return true;
    const desktopCommit = knownValue(desktop.commit);
    const hostCommit = knownValue(host.commit);
    return Boolean(desktopCommit && hostCommit && desktopCommit !== hostCommit);
}
