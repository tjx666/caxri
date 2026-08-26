import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Compares secret material through fixed-length digests so mismatched lengths and prefixes do not leak through an
 * early-returning string comparison.
 */
export function isSecretMatch(candidate: string, expected: string): boolean {
    const candidateDigest = createHash('sha256').update(candidate).digest();
    const expectedDigest = createHash('sha256').update(expected).digest();
    return timingSafeEqual(candidateDigest, expectedDigest);
}
