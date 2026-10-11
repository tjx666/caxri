import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import { CaxriError } from '@caxri/protocol';

/**
 * Permission bits for a user-owned config file that does not exist yet. Provider configs such as Claude Code's
 * `settings.json` can carry credential-bearing `env` entries, so a new file starts owner-only like Server-owned files.
 */
const NEW_USER_CONFIG_MODE = 0o600;

interface ReplaceOptions {
    mode: number;
    /**
     * Reapplies `mode` with `fchmod` after creating the temporary file. `open` narrows its mode by the process umask,
     * which is right for a fresh Server-owned file but would silently tighten preserved user permission bits.
     */
    exactMode?: boolean;
}

/**
 * Durably replaces a small Server-owned file through an exclusive same-directory temporary file. The rename replaces
 * the final directory entry itself, so a symlink at `path` becomes a standalone regular file and the result carries
 * `mode` (narrowed by the umask) whatever the previous file used. User-owned config that Caxri edits but does not own
 * goes through {@link atomicWriteUserConfig} instead. Document saves and Server profile writes retain their stricter
 * inode/CAS contracts and must not use either helper.
 */
export async function atomicWrite(path: string, source: string, mode = 0o600): Promise<void> {
    await replaceFile(path, source, { mode });
}

/**
 * Durably replaces a small user-owned config file that Caxri edits but does not own, such as a provider's lifecycle
 * hook config (`~/.claude/settings.json`), which users commonly symlink into a dotfiles repository.
 *
 * - A final symlink is resolved with `realpath` and its canonical target is replaced, with the temporary file in the
 *   target's directory, so the link survives and the dotfiles source receives the change. Reads already follow final
 *   symlinks (`readBoundedRegularFile`); replacing the link instead would silently fork the config from its source.
 * - A dangling symlink fails closed with `CONFLICT` rather than becoming a regular file: the link records where the user
 *   keeps the config, and only the user can say whether its target should be restored. `CONFLICT` is therefore the one
 *   code callers surface as user-resolvable rather than retryable (`AgentHookManager` reports it as `conflict`
 *   health).
 * - An existing file keeps its exact permission bits; forcing `0600` would silently change a file the user owns. A new
 *   file starts at {@link NEW_USER_CONFIG_MODE}.
 * - Like any rename-based replacement, the canonical target gets a new inode, so hard links to it are not updated.
 */
export async function atomicWriteUserConfig(path: string, source: string): Promise<void> {
    const target = await resolveUserConfigTarget(path);
    await replaceFile(target.path, source, { exactMode: true, mode: target.mode });
}

async function resolveUserConfigTarget(path: string): Promise<{ mode: number; path: string }> {
    let entry: Stats;
    try {
        entry = await lstat(path);
    } catch (error) {
        if (isMissing(error)) return { mode: NEW_USER_CONFIG_MODE, path };
        throw error;
    }
    if (!entry.isSymbolicLink()) return regularFileTarget(path, entry);
    let canonical: string;
    try {
        canonical = await realpath(path);
    } catch (error) {
        if (!isMissing(error)) throw error;
        // The basename is as specific as provider health messages get; full paths stay out of diagnostics.
        throw new CaxriError(
            'CONFLICT',
            `${basename(path)} is a symlink to a missing file. Restore the link target or remove the link.`,
        );
    }
    return regularFileTarget(canonical, await stat(canonical));
}

function regularFileTarget(path: string, stats: Stats): { mode: number; path: string } {
    if (!stats.isFile()) throw new CaxriError('IO', `${basename(path)} is not a regular file`);
    return { mode: stats.mode & 0o777, path };
}

function isMissing(error: unknown): boolean {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

async function replaceFile(path: string, source: string, options: ReplaceOptions): Promise<void> {
    const directory = dirname(path);
    await mkdir(directory, { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        const file = await open(temporary, 'wx', options.mode);
        try {
            if (options.exactMode) await file.chmod(options.mode);
            await file.writeFile(source, 'utf8');
            await file.sync();
        } finally {
            await file.close();
        }
        await rename(temporary, path);
        const directoryHandle = await open(directory, constants.O_RDONLY);
        try {
            await directoryHandle.sync();
        } finally {
            await directoryHandle.close();
        }
    } finally {
        await rm(temporary, { force: true });
    }
}
