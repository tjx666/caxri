import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import process from 'node:process';

import { CaxriError } from '@caxri/protocol';

import { isAccessible } from '../shared/node/fs';

/**
 * Common CLI-shim locations missing from the constrained PATH a macOS GUI launch inherits (`/usr/bin:/bin:...`), where
 * Homebrew and "Install 'code' command in PATH" style shims actually live.
 */
const FALLBACK_EXECUTABLE_DIRECTORIES = ['/usr/local/bin', '/opt/homebrew/bin'];

/**
 * Expands a `workbench.externalEditor` command into the absolute-path candidates to probe, in order. A command
 * containing a path separator is used as-is; a bare name is searched on PATH first, then in the fallback directories.
 */
export function editorExecutableCandidates(
    command: string,
    environmentPath: string | undefined,
): string[] {
    if (command.includes('/')) return [command];
    const directories = [
        ...(environmentPath?.split(delimiter) ?? []),
        ...FALLBACK_EXECUTABLE_DIRECTORIES,
    ];
    return [...new Set(directories.filter(Boolean))].map((directory) => join(directory, command));
}

async function resolveEditorExecutable(command: string): Promise<string> {
    const probed = await Promise.all(
        editorExecutableCandidates(command, process.env.PATH).map(async (candidate) =>
            // Inaccessible candidates drop out; the ordered `find` below picks the first survivor.
            (await isAccessible(candidate, constants.X_OK)) ? candidate : undefined,
        ),
    );
    const executable = probed.find((candidate) => candidate !== undefined);
    if (executable) return executable;
    throw new CaxriError(
        'NOT_FOUND',
        `External editor command "${command}" was not found. Check the "External editor" setting.`,
    );
}

/**
 * Launches the configured external editor with the authorized Project root as its only argument. The editor is a
 * detached child so quitting Caxri never tears it down.
 */
export async function launchExternalEditor(
    command: string | null | undefined,
    projectPath: string,
): Promise<void> {
    const trimmed = command?.trim();
    if (!trimmed)
        throw new CaxriError(
            'VALIDATION',
            'No external editor is configured. Set "External editor" in Settings.',
        );
    const executable = await resolveEditorExecutable(trimmed);
    await new Promise<void>((resolve, reject) => {
        const child = spawn(executable, [projectPath], { detached: true, stdio: 'ignore' });
        child.once('spawn', () => {
            child.unref();
            resolve();
        });
        child.once('error', (error) =>
            reject(new CaxriError('INTERNAL', `External editor failed to start: ${error.message}`)),
        );
    });
}
