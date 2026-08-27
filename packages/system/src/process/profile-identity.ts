import { createHash } from 'node:crypto';

/**
 * Stable, content-free identity for one canonical runtime profile directory.
 */
export function profileIdForPath(canonicalProfilePath: string): string {
    return createHash('sha256').update(canonicalProfilePath).digest('hex').slice(0, 24);
}
