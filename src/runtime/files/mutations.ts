import { lstat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

import { CaxriError, isCaxriError } from '../../shared/ipc/errors';
import type { RuntimeMethodParams, RuntimeMethodResult } from '../../shared/ipc/methods';
import type { StructuredLogger } from '../../shared/node/logger';
import type { NativeFileOperations } from '../../shared/node/native-file-operations';
import {
    type NativeFileIdentity,
    type NativeProjectEntry,
} from '../../shared/node/native-file-operations';
import type { ResolveSessionPath } from './documents';

type MutableEntry = RuntimeMethodResult<'files.create'>;
type MovedEntry = RuntimeMethodResult<'files.rename'>;
type ResolvedMutableEntry = MutableEntry & NativeProjectEntry;
export type FileMutationOperations = Pick<NativeFileOperations, 'create' | 'move'>;

function fileName(name: string): string {
    const normalized = name.trim();
    if (
        !normalized ||
        normalized.length > 255 ||
        normalized === '.' ||
        normalized === '..' ||
        normalized.includes('/') ||
        normalized.includes('\\') ||
        normalized.includes('\0')
    )
        throw new CaxriError('VALIDATION', 'Enter a valid file name without path separators');
    return normalized;
}

function isSameOrInside(parent: string, candidate: string): boolean {
    const nested = relative(parent, candidate);
    return (
        nested === '' || (nested !== '..' && !nested.startsWith(`..${sep}`) && !isAbsolute(nested))
    );
}

function mutationError(error: unknown, action: string): CaxriError {
    if (isCaxriError(error)) return error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return new CaxriError('NOT_FOUND', 'File or folder no longer exists');
    if (code === 'EEXIST' || code === 'ENOTEMPTY')
        return new CaxriError('CONFLICT', 'A file or folder with that name already exists');
    if (code === 'EACCES' || code === 'EPERM')
        return new CaxriError('PATH_DENIED', `Permission denied while ${action}`);
    return new CaxriError('IO', `Unable to ${action}`);
}

/** Owns create, rename, move, and Trash authorization under a canonical Session Project root. */
export class FileMutationService {
    constructor(
        private readonly resolveSessionPath: ResolveSessionPath,
        private readonly logger: StructuredLogger,
        private readonly nativeFileOperations: FileMutationOperations,
    ) {}

    async create(
        params: RuntimeMethodParams<'files.create'>,
    ): Promise<RuntimeMethodResult<'files.create'>> {
        try {
            const directory = await this.resolveExisting(params.sessionId, params.directory, true);
            if (directory.kind !== 'directory')
                throw new CaxriError('IO', 'New files can only be created in a folder');
            const name = fileName(params.name);
            const path = resolve(directory.path, name);
            await this.nativeFileOperations.create(directory, name);
            this.logger.write('info', 'file.created', {
                fields: { sessionId: params.sessionId, path: relative(directory.root.path, path) },
            });
            return { kind: 'file', name, path };
        } catch (error) {
            throw mutationError(error, 'creating the file');
        }
    }

    rename(
        params: RuntimeMethodParams<'files.rename'>,
    ): Promise<RuntimeMethodResult<'files.rename'>> {
        return this.moveTo(params.sessionId, params.path, undefined, fileName(params.name));
    }

    move(params: RuntimeMethodParams<'files.move'>): Promise<RuntimeMethodResult<'files.move'>> {
        return this.moveTo(params.sessionId, params.path, params.directory);
    }

    async authorizeTrash(
        params: RuntimeMethodParams<'files.authorizeTrash'>,
    ): Promise<RuntimeMethodResult<'files.authorizeTrash'>> {
        const entry = await this.resolveExisting(params.sessionId, params.path);
        return {
            kind: entry.kind,
            name: entry.name,
            path: entry.path,
            device: entry.device,
            inode: entry.inode,
            root: entry.root,
        };
    }

    private async moveTo(
        sessionId: string,
        sourcePath: string,
        targetDirectoryPath?: string,
        requestedName?: string,
    ): Promise<MovedEntry> {
        try {
            const source = await this.resolveExisting(sessionId, sourcePath);
            const directory = await this.resolveExisting(
                sessionId,
                targetDirectoryPath ?? resolve(source.path, '..'),
                true,
            );
            if (directory.kind !== 'directory')
                throw new CaxriError('IO', 'Files can only be moved into a folder');
            if (source.kind === 'directory' && isSameOrInside(source.path, directory.path))
                throw new CaxriError('CONFLICT', 'A folder cannot be moved into itself');

            const name = requestedName ?? basename(source.path);
            const targetPath = resolve(directory.path, name);
            if (targetPath === source.path)
                return {
                    kind: source.kind,
                    name,
                    path: source.path,
                    previousPath: source.path,
                };

            await this.nativeFileOperations.move(source, directory, name);
            this.logger.write('info', 'file.moved', {
                fields: {
                    sessionId,
                    from: relative(source.root.path, source.path),
                    to: relative(source.root.path, targetPath),
                },
            });
            return { kind: source.kind, name, path: targetPath, previousPath: source.path };
        } catch (error) {
            throw mutationError(error, requestedName ? 'renaming the item' : 'moving the item');
        }
    }

    private async resolveExisting(
        sessionId: string,
        input: string,
        allowRoot = false,
    ): Promise<ResolvedMutableEntry> {
        const root = await this.resolveSessionPath(sessionId);
        const lexicalPath = isAbsolute(input) ? resolve(input) : resolve(root.root, input);
        const resolved = await this.resolveSessionPath(sessionId, lexicalPath);
        if (resolved.root !== root.root)
            throw new CaxriError('PATH_DENIED', 'Path is outside the Project root');
        const lexicalStats = await lstat(lexicalPath, { bigint: true });
        if (lexicalStats.isSymbolicLink())
            throw new CaxriError('PATH_DENIED', 'Symbolic links cannot be changed');
        if (!allowRoot && resolved.path === resolved.root)
            throw new CaxriError('PATH_DENIED', 'The Project root cannot be changed');
        const [stats, rootStats] = await Promise.all([
            lstat(resolved.path, { bigint: true }),
            lstat(resolved.root, { bigint: true }),
        ]);
        if (
            stats.isSymbolicLink() ||
            lexicalStats.dev !== stats.dev ||
            lexicalStats.ino !== stats.ino ||
            (!stats.isFile() && !stats.isDirectory())
        )
            throw new CaxriError('PATH_DENIED', 'Only regular files and folders can be changed');
        if (rootStats.isSymbolicLink() || !rootStats.isDirectory())
            throw new CaxriError('PATH_DENIED', 'Project root is no longer a directory');
        const rootIdentity: NativeFileIdentity = {
            path: resolved.root,
            device: rootStats.dev.toString(),
            inode: rootStats.ino.toString(),
        };
        return {
            root: rootIdentity,
            path: resolved.path,
            name: basename(resolved.path),
            kind: stats.isDirectory() ? 'directory' : 'file',
            device: stats.dev.toString(),
            inode: stats.ino.toString(),
        };
    }
}
