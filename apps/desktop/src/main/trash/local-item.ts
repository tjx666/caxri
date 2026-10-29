import { execFile } from 'node:child_process';
import { access, constants, mkdir, rename } from 'node:fs/promises';
import { basename, join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { shell } from 'electron';

const execFileAsync = promisify(execFile);

/**
 * MacOS 15 and later ship this tool. It moves items through the same `NSFileManager` call Finder uses and, with
 * `--verbose`, reports where each one landed, which `shell.trashItem` (a `Promise<void>`) never does.
 */
const MACOS_TRASH_TOOL = '/usr/bin/trash';

/**
 * Reads the destination from the tool's `# Moved "<from>" to "<to>"` line. The match is greedy, so a source path that
 * contains `to` cannot shift it. A destination that itself contains `to` is ambiguous, and any misread is caught by the
 * identity check on the Server, which yields no Undo rather than a wrong one.
 */
export function parseTrashedPath(output: string): string | undefined {
    const lines = output.split('\n').filter((line) => line.startsWith('# Moved "'));
    const match = /^.*" to "(.*)"\s*$/u.exec(lines.at(-1) ?? '');
    const destination = match?.[1];
    return destination === '' ? undefined : destination;
}

async function hasMacosTrashTool(): Promise<boolean> {
    try {
        await access(MACOS_TRASH_TOOL, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/**
 * Moves a local path into the system Trash and returns where it landed, or `undefined` when this platform cannot say.
 *
 * Reporting the location is what makes a safe Undo possible: Caxri never guesses a Trash path. Platforms without the
 * macOS tool keep Electron's `shell.trashItem`, so the move itself behaves as before and only the Undo is absent.
 */
export async function trashLocalItem(path: string): Promise<string | undefined> {
    if (process.env.CAXRI_E2E === '1') return trashIntoE2EDirectory(path);
    if (process.platform !== 'darwin' || !(await hasMacosTrashTool())) {
        await shell.trashItem(path);
        return undefined;
    }
    const { stdout } = await execFileAsync(MACOS_TRASH_TOOL, ['--stopOnError', '--verbose', path]);
    return parseTrashedPath(stdout);
}

/**
 * E2E stand-in for the system Trash, so a test never touches the developer's own. With `CAXRI_E2E_TRASH_DIR` set the
 * item is renamed into that fixture directory, which is exactly what the macOS tool does on one volume, and the real
 * Server then records and restores it. Without the variable the spec's own `shell.trashItem` stub applies.
 */
async function trashIntoE2EDirectory(path: string): Promise<string | undefined> {
    const directory = process.env.CAXRI_E2E_TRASH_DIR;
    if (!directory) {
        await shell.trashItem(path);
        return undefined;
    }
    await mkdir(directory, { recursive: true });
    const destination = join(directory, `${Date.now()}-${basename(path)}`);
    await rename(path, destination);
    return destination;
}
