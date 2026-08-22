import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { CaxriError } from '../../shared/ipc/errors';
import type { CaxriDatabase } from '../db';
import { isSameOrInside } from '../path-security';

interface TerminalFileLinkResolverOptions {
    userHome?: string;
}

interface TerminalFileIdentity {
    device: string;
    inode: string;
    root: { path: string; device: string; inode: string };
}

export type TerminalFileLinkResolution =
    | {
          status: 'authorization_required';
          path: string;
          sourceSessionId: string;
      }
    | {
          status: 'authorized';
          identity: TerminalFileIdentity;
          path: string;
          projectId: string;
          sourceSessionId: string;
      }
    | {
          status: 'selection_authorized';
          identity: TerminalFileIdentity;
          path: string;
          rootPath: string;
          sourceSessionId: string;
      };

function missingFile(error: unknown): never {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR')
        throw new CaxriError('NOT_FOUND', 'Terminal link target was not found');
    throw error;
}

async function lstatExisting(path: string) {
    try {
        return await lstat(path, { bigint: true });
    } catch (error) {
        return missingFile(error);
    }
}

async function realpathExisting(path: string): Promise<string> {
    try {
        return await realpath(path);
    } catch (error) {
        return missingFile(error);
    }
}

async function resolveRegularFile(rootPath: string, candidate: string) {
    const rootBefore = await lstatExisting(rootPath);
    if (rootBefore.isSymbolicLink() || !rootBefore.isDirectory())
        throw new CaxriError('PATH_DENIED', 'Selected Project root is not a directory');
    const canonicalRoot = await realpathExisting(rootPath);
    const canonicalTarget = await realpathExisting(candidate);
    const [rootAfter, target] = await Promise.all([
        lstatExisting(rootPath),
        lstatExisting(canonicalTarget),
    ]);
    if (
        rootAfter.isSymbolicLink() ||
        !rootAfter.isDirectory() ||
        rootAfter.dev !== rootBefore.dev ||
        rootAfter.ino !== rootBefore.ino ||
        (await realpathExisting(rootPath)) !== canonicalRoot
    )
        throw new CaxriError('PATH_DENIED', 'Selected Project root changed during authorization');
    if (!isSameOrInside(canonicalRoot, canonicalTarget))
        throw new CaxriError('PATH_DENIED', 'Terminal link target is outside the selected Project');
    if (!target.isFile())
        throw new CaxriError('VALIDATION', 'Terminal link target is not a regular file');
    return {
        identity: {
            device: target.dev.toString(),
            inode: target.ino.toString(),
            root: {
                path: canonicalRoot,
                device: rootAfter.dev.toString(),
                inode: rootAfter.ino.toString(),
            },
        },
        path: canonicalTarget,
        rootPath: canonicalRoot,
    };
}

/**
 * Expands a current-user Home link only inside Runtime and proves the target against an already added Project or a
 * directory the user explicitly selected in Main. The first pass deliberately does not stat paths outside every
 * Project: Terminal output alone cannot acquire filesystem read authority.
 */
export async function resolveTerminalFileLink(
    database: CaxriDatabase,
    parameters: { terminalId: string; target: string; selectedRoot?: string },
    options: TerminalFileLinkResolverOptions = {},
): Promise<TerminalFileLinkResolution> {
    const terminal = database.getTerminal(parameters.terminalId);
    if (!terminal) throw new CaxriError('NOT_FOUND', 'Terminal not found');
    if (!/^~\/.+/u.test(parameters.target))
        throw new CaxriError('VALIDATION', 'Only current-user ~/ Terminal links are supported');

    const userHome = await realpathExisting(options.userHome ?? homedir());
    const candidate = resolve(userHome, parameters.target.slice(2));
    if (!isSameOrInside(userHome, candidate))
        throw new CaxriError('PATH_DENIED', 'Terminal link escapes the current user Home');

    if (parameters.selectedRoot) {
        const selected = await resolveRegularFile(parameters.selectedRoot, candidate);
        return {
            status: 'selection_authorized',
            ...selected,
            sourceSessionId: terminal.sessionId,
        };
    }

    const project = database
        .listProjects()
        .filter(({ rootPath }) => isSameOrInside(rootPath, candidate))
        .toSorted((left, right) => right.rootPath.length - left.rootPath.length)
        .at(0);
    if (!project)
        return {
            status: 'authorization_required',
            path: candidate,
            sourceSessionId: terminal.sessionId,
        };

    const authorized = await resolveRegularFile(project.rootPath, candidate);
    return {
        status: 'authorized',
        identity: authorized.identity,
        path: authorized.path,
        projectId: project.id,
        sourceSessionId: terminal.sessionId,
    };
}
