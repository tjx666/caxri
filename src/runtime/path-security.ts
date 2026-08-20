import { isAbsolute, relative, sep } from 'node:path';

import { CaxriError } from '../shared/ipc/errors';

/**
 * Distinguishes real parent traversal from valid names such as `..odd.txt`.
 */
export function isOutsideRoot(relativePath: string): boolean {
    return relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
}

/**
 * Tests whether a candidate is the same path as, or a descendant of, a parent without granting path authority.
 */
export function isSameOrInside(parent: string, candidate: string): boolean {
    return !isOutsideRoot(relative(parent, candidate));
}

/**
 * Single throw site for path-authority violations so every escape reports `PATH_DENIED`.
 */
export function assertInsideRoot(relativePath: string, message: string): void {
    if (isOutsideRoot(relativePath)) throw new CaxriError('PATH_DENIED', message);
}
