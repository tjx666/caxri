import { isAbsolute, sep } from 'node:path';

/** Distinguishes real parent traversal from valid names such as `..odd.txt`. */
export function isOutsideRoot(relativePath: string): boolean {
    return relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
}
