/**
 * Build identity of one side of the Desktop↔Server attachment. Fields are compared only when both sides report a real
 * value; `undefined` and the `'unknown'` build-time fallback mean "cannot tell", never "different".
 */
export interface ServerBuildIdentity {
    buildId?: string;
    commit?: string;
    version?: string;
}

function knownValue(value: string | undefined): string | undefined {
    return value && value !== 'unknown' ? value : undefined;
}

/**
 * Decides whether a discovered Server process was built from different code than the connecting Desktop and must be
 * replaced before serving requests. A detached Server survives Desktop restarts, so after a rebuild (dev) or an app
 * upgrade (packaged) the adopted Server can silently keep running an older build, exactly the failure this check
 * closes.
 *
 * The per-build `buildId` is authoritative when both sides carry one: it is the only identity that distinguishes two
 * dev builds of the same (possibly dirty) checkout, where version and commit are identical. Version/commit remain as
 * the fallback for Servers built before the buildId existed.
 */
export function isServerBuildStale(
    desktop: ServerBuildIdentity,
    server: ServerBuildIdentity,
): boolean {
    const desktopBuildId = knownValue(desktop.buildId);
    const serverBuildId = knownValue(server.buildId);
    if (desktopBuildId && serverBuildId) return desktopBuildId !== serverBuildId;
    const desktopVersion = knownValue(desktop.version);
    const serverVersion = knownValue(server.version);
    if (desktopVersion && serverVersion && desktopVersion !== serverVersion) return true;
    const desktopCommit = knownValue(desktop.commit);
    const serverCommit = knownValue(server.commit);
    return Boolean(desktopCommit && serverCommit && desktopCommit !== serverCommit);
}
