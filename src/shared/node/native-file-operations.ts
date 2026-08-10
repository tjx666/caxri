import { execFile } from 'node:child_process';
import { relative, sep } from 'node:path';
import { promisify } from 'node:util';

import { CaxriError } from '../ipc/errors';

const run = promisify(execFile);

type NativeFileOperationRunner = (
    executable: string,
    args: string[],
    options: { windowsHide: boolean },
) => Promise<unknown>;

const runNativeFileOperation: NativeFileOperationRunner = (executable, args, options) =>
    run(executable, args, options);

export interface NativeFileIdentity {
    device: string;
    inode: string;
    path: string;
}

export interface NativeProjectEntry extends NativeFileIdentity {
    root: NativeFileIdentity;
}

type NativeFileOperation = 'create' | 'move' | 'trash' | 'trash-test';

function unsigned(value: string): string {
    if (!/^\d+$/.test(value)) throw new CaxriError('INTERNAL', 'File identity is invalid');
    return value;
}

function beneath(root: string, path: string): string {
    const value = relative(root, path);
    if (value === '') return '.';
    if (value === '..' || value.startsWith(`..${sep}`))
        throw new CaxriError('PATH_DENIED', 'Path is outside the Project root');
    return value;
}

function operationError(error: unknown): CaxriError {
    const rawStderr = (error as { stderr?: unknown }).stderr;
    const stderr =
        typeof rawStderr === 'string'
            ? rawStderr
            : Buffer.isBuffer(rawStderr)
              ? rawStderr.toString('utf8')
              : '';
    const recoveryName = /(?:^|\n)RECOVERED:([^\r\n]+)/.exec(stderr)?.[1];
    if (recoveryName)
        return new CaxriError(
            'CONFLICT',
            `Files changed concurrently. The original item was preserved as '${recoveryName}'`,
        );
    const exitCode = (error as { code?: unknown }).code;
    if (exitCode === 64) return new CaxriError('VALIDATION', 'File operation input is invalid');
    if (exitCode === 66) return new CaxriError('NOT_FOUND', 'File or folder no longer exists');
    if (exitCode === 69)
        return new CaxriError('UNAVAILABLE', 'File operations are unavailable on this system');
    if (exitCode === 73)
        return new CaxriError('CONFLICT', 'A file or folder with that name already exists');
    if (exitCode === 77)
        return new CaxriError('PATH_DENIED', 'File operation left the Project root');
    return new CaxriError('IO', 'Native file operation failed');
}

/**
 * Invokes the bundled helper that anchors mutations to Project-root directory descriptors. Node's
 * path APIs cannot express `openat` traversal or an atomic no-replace directory rename.
 */
export class NativeFileOperations {
    constructor(
        private readonly executable: string,
        private readonly runner: NativeFileOperationRunner = runNativeFileOperation,
    ) {}

    create(directory: NativeProjectEntry, name: string): Promise<void> {
        return this.execute('create', [
            directory.root.path,
            unsigned(directory.root.device),
            unsigned(directory.root.inode),
            beneath(directory.root.path, directory.path),
            unsigned(directory.device),
            unsigned(directory.inode),
            name,
        ]);
    }

    move(source: NativeProjectEntry, directory: NativeProjectEntry, name: string): Promise<void> {
        return this.execute('move', [
            source.root.path,
            unsigned(source.root.device),
            unsigned(source.root.inode),
            beneath(source.root.path, source.path),
            unsigned(source.device),
            unsigned(source.inode),
            beneath(directory.root.path, directory.path),
            unsigned(directory.device),
            unsigned(directory.inode),
            name,
        ]);
    }

    trash(source: NativeProjectEntry, testMode = false): Promise<void> {
        return this.execute(testMode ? 'trash-test' : 'trash', [
            source.root.path,
            unsigned(source.root.device),
            unsigned(source.root.inode),
            beneath(source.root.path, source.path),
            unsigned(source.device),
            unsigned(source.inode),
        ]);
    }

    private async execute(operation: NativeFileOperation, args: string[]): Promise<void> {
        try {
            /**
             * Do not add an exec timeout here. The helper may already own a staged user-file
             * transaction; killing it would prevent its conflict recovery from restoring the item.
             */
            await this.runner(this.executable, [operation, ...args], {
                windowsHide: true,
            });
        } catch (error) {
            throw operationError(error);
        }
    }
}
