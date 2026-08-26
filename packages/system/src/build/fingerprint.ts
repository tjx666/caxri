import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Bundles whose bytes define one Server generation. Core, Extension Host and Terminal Host must move as one exact-head
 * deployment even though each independently loaded process owns a different failure and capability boundary.
 */
const FINGERPRINT_BUNDLES = ['server-core.js', 'extension-host.js', 'terminal-host.js'] as const;

/**
 * Content fingerprint of the built Server bundles in an output directory. Build-time identifiers (a `define`-injected
 * UUID) cannot be trusted here: development builds the Desktop and on-disk `server-core.js` in separate config
 * evaluations, so an identifier baked into each would differ even when the code is identical. Hashing the actual bytes
 * makes the Desktop and the Server it spawned agree by construction, and a watch rebuild changes the fingerprint so a
 * genuinely stale detached Server is still detected. Returns `undefined` when a bundle is unreadable so callers skip
 * the staleness comparison instead of guessing.
 */
export async function computeBuildFingerprint(
    outputDirectory: string,
): Promise<string | undefined> {
    try {
        const bundles = await Promise.all(
            FINGERPRINT_BUNDLES.map((name) => readFile(join(outputDirectory, name))),
        );
        const hash = createHash('sha256');
        for (const bundle of bundles) hash.update(bundle);
        return hash.digest('hex').slice(0, 16);
    } catch {
        return undefined;
    }
}
