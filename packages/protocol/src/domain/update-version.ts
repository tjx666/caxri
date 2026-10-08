/**
 * Version ordering for the update contract, shared by Electron Main (which decides whether a GitHub release is newer
 * than the running build) and the Renderer (which decides whether a discovered release is still covered by the version
 * the user skipped). Both answers have to agree (a Renderer that hid an update Main considered new, or offered one it
 * considered old, would be the same bug in two directions), so the comparison lives in the protocol rather than being
 * written twice.
 */

function stableVersionParts(version: string): [number, number, number] {
    const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
    if (!match) throw new Error('The release has an unsupported version number.');
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Compares the stable `major.minor.patch` versions used by Caxri releases. Throws for anything else, including
 * prerelease tags: Caxri only ships stable releases, so an unexpected shape is a release-feed fault to surface rather
 * than a value to guess an ordering for.
 */
export function compareStableVersions(left: string, right: string): number {
    const leftParts = stableVersionParts(left);
    const rightParts = stableVersionParts(right);
    for (const [index, leftPart] of leftParts.entries()) {
        const difference = leftPart - rightParts[index];
        if (difference !== 0) return Math.sign(difference);
    }
    return 0;
}

/**
 * Does the persisted `updates.skippedVersion` still cover this release?
 *
 * `Skip this version` is deliberately not "never update again": it silences the offer only until something newer than
 * the skipped version appears, so a user who declined one release still hears about the next one. The skipped value is
 * hand-editable in `settings.jsonc`, so an unparsable entry must not throw here: it falls back to exact-string
 * matching, which keeps the setting inert for every other version instead of taking the whole update surface down.
 */
export function isUpdateVersionSkipped(
    version: string,
    skippedVersion: string | null | undefined,
): boolean {
    if (!skippedVersion) return false;
    try {
        return compareStableVersions(version, skippedVersion) <= 0;
    } catch {
        return version === skippedVersion;
    }
}
