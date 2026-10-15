import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { lstat, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { CommandError } from './process';
import { errorCode } from './repo';

export const PRESERVED_PROFILE_MARKER = '.caxri-preserved-profile';

export interface ProfileRemoval {
    kept: boolean;
    path?: string;
    profileRoot?: string;
    shouldDelete: boolean;
}

async function isProfileDirectorySafe(path: string, operation: string): Promise<boolean> {
    try {
        const metadata = await lstat(path);
        if (!metadata.isDirectory() || metadata.isSymbolicLink())
            throw new CommandError(
                `Refusing to ${operation} non-directory isolated profile: ${path}`,
            );
        return true;
    } catch (error) {
        if (errorCode(error) === 'ENOENT') return false;
        throw error;
    }
}

async function writePreservationMarker(profile: string, worktreePath: string): Promise<void> {
    const marker = join(profile, PRESERVED_PROFILE_MARKER);
    let handle: FileHandle | undefined;
    try {
        handle = await open(
            marker,
            constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            0o600,
        );
        const metadata = await handle.stat();
        if (
            !metadata.isFile() ||
            metadata.nlink !== 1 ||
            (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
        ) {
            throw new CommandError(
                `Refusing to overwrite unsafe preserved profile marker: ${marker}`,
            );
        }
        await handle.truncate(0);
        await handle.writeFile(
            `${JSON.stringify({ preservedAt: new Date().toISOString(), worktreePath })}\n`,
            'utf8',
        );
    } catch (error) {
        if (error instanceof CommandError) throw error;
        throw new CommandError(`Refusing to overwrite unsafe preserved profile marker: ${marker}`);
    } finally {
        await handle?.close();
    }
}

export async function prepareProfileRemoval(
    stateDirectory: string,
    identity: string | undefined,
    shouldPreserve: boolean,
    worktreePath: string,
): Promise<ProfileRemoval> {
    if (!identity) return { kept: false, shouldDelete: false };
    const profileRoot = join(stateDirectory, 'profiles');
    const rootExists = await isProfileDirectorySafe(profileRoot, 'use');
    const path = join(profileRoot, identity);
    if (!rootExists) return { kept: false, path, profileRoot, shouldDelete: false };
    const exists = await isProfileDirectorySafe(path, shouldPreserve ? 'preserve' : 'clean');
    if (!exists) return { kept: false, path, profileRoot, shouldDelete: false };
    if (shouldPreserve) await writePreservationMarker(path, worktreePath);
    return { kept: shouldPreserve, path, profileRoot, shouldDelete: !shouldPreserve };
}

export async function finishProfileRemoval(removal: ProfileRemoval): Promise<void> {
    if (!removal.path || !removal.profileRoot || !removal.shouldDelete) return;
    if (!(await isProfileDirectorySafe(removal.profileRoot, 'clean from'))) return;
    if (!(await isProfileDirectorySafe(removal.path, 'clean'))) return;
    await rm(removal.path, { force: true, recursive: true });
}
