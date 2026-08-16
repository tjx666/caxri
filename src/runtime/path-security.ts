import { isAbsolute, sep } from 'node:path';

import { CaxriError } from '../shared/ipc/errors';

/**
 * Distinguishes real parent traversal from valid names such as `..odd.txt`.
 */
export function isOutsideRoot(relativePath: string): boolean {
    return relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
}

/**
 * Single throw site for path-authority violations so every escape reports `PATH_DENIED`.
 */
export function assertInsideRoot(relativePath: string, message: string): void {
    if (isOutsideRoot(relativePath)) throw new CaxriError('PATH_DENIED', message);
}
