import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Bundles whose bytes define one Host generation: replacing either one changes the behavior a detached Host serves, so
 * both participate in the fingerprint.
 */
const FINGERPRINT_BUNDLES = ['host.js', 'runtime.js'] as const;

/**
 * Content fingerprint of the built Host + Runtime bundles in an output directory. Build-time identifiers (a
 * `define`-injected UUID) cannot be trusted here: in electron-vite dev the window bundle and the on-disk `host.js` come
 * from separate config evaluations, so an identifier baked into each would differ even when the code is identical.
 * Hashing the actual bytes makes the Desktop and the Host it spawned agree by construction, and a watch rebuild changes
 * the fingerprint so a genuinely stale detached Host is still detected. Returns `undefined` when a bundle is unreadable
 * so callers skip the staleness comparison instead of guessing.
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
