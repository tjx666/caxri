import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { CaxriError } from '@caxri/protocol';

import { isSameOrInside } from '../path-security';

export interface TerminalWorkingDirectoryOptions {
    authorizedRoots: readonly string[];
    configured?: string;
    defaultRoot: string;
    requestedCwd?: string;
}

async function validateDirectory(path: string): Promise<void> {
    if (!(await stat(path)).isDirectory())
        throw new CaxriError('VALIDATION', 'Terminal working directory must be a folder');
    await access(path, constants.X_OK);
}

export async function resolveTerminalWorkingDirectory({
    authorizedRoots,
    configured,
    defaultRoot,
    requestedCwd,
}: TerminalWorkingDirectoryOptions): Promise<string> {
    if (requestedCwd) {
        if (!isAbsolute(requestedCwd))
            throw new CaxriError('VALIDATION', 'Terminal working directory must be absolute');
        let canonicalRoots: string[];
        let canonical: string;
        try {
            [canonicalRoots, canonical] = await Promise.all([
                Promise.all(authorizedRoots.map((root) => realpath(root))),
                realpath(requestedCwd),
            ]);
            await validateDirectory(canonical);
        } catch (error) {
            if (error instanceof CaxriError) throw error;
            throw new CaxriError('IO', 'Terminal working directory is unavailable');
        }
        if (canonicalRoots.every((root) => !isSameOrInside(root, canonical)))
            throw new CaxriError(
                'PATH_DENIED',
                'Terminal working directory must stay inside an authorized Session root',
            );
        return canonical;
    }
    if (!configured) return defaultRoot;
    const expanded =
        configured === '~'
            ? homedir()
            : configured.startsWith('~/')
              ? join(homedir(), configured.slice(2))
              : configured;
    if (!isAbsolute(expanded))
        throw new CaxriError(
            'VALIDATION',
            'Terminal default working directory must be absolute or start with ~',
        );
    try {
        const canonical = await realpath(expanded);
        await validateDirectory(canonical);
        return canonical;
    } catch (error) {
        throw new CaxriError(
            'IO',
            `Terminal default working directory is unavailable: ${String(error)}`,
        );
    }
}
