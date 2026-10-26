import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const LAUNCH_VERSION_FILE = 'last-launched-version.json';

/**
 * The version to announce as "updated from", or `undefined` when nothing should be announced: the first install (no
 * recorded version), an unchanged launch, and a downgrade all stay silent. Only a strictly different recorded version
 * counts, so a reinstall of the same build never repeats the notice.
 */
export function detectVersionChange(
    previousVersion: string | undefined,
    currentVersion: string,
): string | undefined {
    if (!previousVersion || previousVersion === currentVersion) return undefined;
    return previousVersion;
}

async function readRecordedVersion(path: string): Promise<string | undefined> {
    try {
        const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (typeof parsed !== 'object' || parsed === null) return undefined;
        const { version } = parsed as { version?: unknown };
        return typeof version === 'string' && version.length > 0 && version.length <= 64
            ? version
            : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Records the running version in a tiny profile file and returns the version this launch replaced, if any. A failure to
 * read or write only drops the one-time notice, so it is swallowed.
 */
export async function recordLaunchVersion(
    userDataPath: string,
    currentVersion: string,
): Promise<string | undefined> {
    const path = join(userDataPath, LAUNCH_VERSION_FILE);
    const updatedFrom = detectVersionChange(await readRecordedVersion(path), currentVersion);
    try {
        await writeFile(path, JSON.stringify({ version: currentVersion }), { mode: 0o600 });
    } catch {
        // Best-effort: the notice is cosmetic.
    }
    return updatedFrom;
}
