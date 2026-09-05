import type { Dirent } from 'node:fs';

/**
 * A `Dirent` stand-in for tests that drive listing and browsing through an injected directory handle instead of a real
 * filesystem, where only the name and entry kind are ever read.
 */
export function fakeDirent(name: string, kind: 'directory' | 'file' = 'file'): Dirent {
    return {
        isDirectory: () => kind === 'directory',
        isSymbolicLink: () => false,
        name,
    } as Dirent;
}
