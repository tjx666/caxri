import { cp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join } from 'node:path';
import process from 'node:process';

import { CaxriError } from '@caxri/protocol';
import { isExistingPath } from '@caxri/system';

/**
 * The home Trash of the freedesktop.org Trash specification (`$XDG_DATA_HOME/Trash`, default `~/.local/share/Trash`),
 * which `gio trash`, GNOME Files, and KDE Dolphin all list and restore from.
 */
export function hostTrashDirectory(environment: NodeJS.ProcessEnv = process.env): string {
    const dataHome = environment.XDG_DATA_HOME;
    return join(
        dataHome && isAbsolute(dataHome) ? dataHome : join(homedir(), '.local', 'share'),
        'Trash',
    );
}

function trashInfoPath(path: string): string {
    return path
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
}

function localDeletionDate(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function isErrorCode(error: unknown, code: string): boolean {
    return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

/**
 * Moves `path` into the host's freedesktop.org home Trash, so an entry removed from an SSH Host window (where
 * Electron's `shell.trashItem` would act on this Mac instead) stays recoverable on the machine it lives on.
 *
 * The `.trashinfo` file is created exclusively first: it reserves the name against a concurrent trasher, as the
 * specification requires. A Project on another filesystem than the home directory cannot be renamed into the home
 * Trash, so it is copied and then removed; the specification's per-mount `$topdir/.Trash-$uid` is not used, because a
 * restore tool that only knows the home Trash would never list it.
 */
export async function moveToHostTrash(
    path: string,
    { directory = hostTrashDirectory(), now = new Date() }: { directory?: string; now?: Date } = {},
): Promise<string> {
    const filesDirectory = join(directory, 'files');
    const infoDirectory = join(directory, 'info');
    await mkdir(filesDirectory, { recursive: true, mode: 0o700 });
    await mkdir(infoDirectory, { recursive: true, mode: 0o700 });
    const name = basename(path);
    const extension = extname(name);
    const stem = extension ? name.slice(0, -extension.length) : name;
    const info = `[Trash Info]\nPath=${trashInfoPath(path)}\nDeletionDate=${localDeletionDate(now)}\n`;
    /**
     * Each candidate depends on whether the previous name was already taken, so the reservations run one at a time.
     */
    for (let index = 1; ; index += 1) {
        const candidate = index === 1 ? name : `${stem}.${index}${extension}`;
        const infoPath = join(infoDirectory, `${candidate}.trashinfo`);
        try {
            // eslint-disable-next-line no-await-in-loop -- sequential name reservation, see above
            await writeFile(infoPath, info, { flag: 'wx', mode: 0o600 });
        } catch (error) {
            if (isErrorCode(error, 'EEXIST')) continue;
            throw error;
        }
        const target = join(filesDirectory, candidate);
        /**
         * A `files/` entry left without its `.trashinfo` (another tool crashed mid-trash) would be silently replaced by
         * `rename`, so that name stays reserved and the next one is tried.
         */
        // eslint-disable-next-line no-await-in-loop -- sequential name reservation, see above
        if (await isExistingPath(target)) continue;
        try {
            // eslint-disable-next-line no-await-in-loop -- runs once, for the reserved name
            await rename(path, target);
        } catch (error) {
            if (!isErrorCode(error, 'EXDEV')) {
                // eslint-disable-next-line no-await-in-loop -- runs once, for the reserved name
                await rm(infoPath, { force: true });
                throw error;
            }
            // eslint-disable-next-line no-await-in-loop -- runs once, for the reserved name
            await copyAcrossFilesystems(path, target, infoPath);
        }
        return target;
    }
}

async function copyAcrossFilesystems(path: string, target: string, infoPath: string) {
    try {
        await cp(path, target, {
            errorOnExist: true,
            force: false,
            preserveTimestamps: true,
            recursive: true,
            verbatimSymlinks: true,
        });
    } catch (error) {
        await rm(target, { force: true, recursive: true });
        await rm(infoPath, { force: true });
        throw new CaxriError('IO', 'Could not copy the item into the Trash', {
            code: (error as NodeJS.ErrnoException).code,
        });
    }
    await rm(path, { recursive: true });
}
