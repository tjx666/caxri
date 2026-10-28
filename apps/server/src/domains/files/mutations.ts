import { Buffer } from 'node:buffer';
import { lstat, mkdir, open, rename } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';

import type { ServerOperationParameters, ServerOperationResult } from '@caxri/protocol';
import { CaxriError, isCaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { isExistingPath, logEventCatalog, mapWithConcurrency } from '@caxri/system';

import { isSameOrInside } from '../path-security';
import type { ResolveSessionPath } from './documents';
import { isStagedCreatePersistenceError } from './mutation-journal';
import type { CopyFile, CopyLimits, FileIdentity } from './mutations-copy';
import {
    assertPathIdentity,
    CopyTreeExecutor,
    createdHandleIdentity,
    createdIdentity,
    DEFAULT_COPY_LIMITS,
    MAX_CONCURRENT_COPY_VALIDATIONS,
    streamCopyFile,
} from './mutations-copy';

type MutableEntry = ServerOperationResult<'files.create'>;
type MovedEntry = ServerOperationResult<'files.rename'>;
type MutationStage<Result> = (expectedResult: Result) => Promise<void>;
interface StagedCreatedEntry extends MutableEntry {
    birthtime?: string;
    device?: string;
    inode?: string;
}
interface StagedMovedEntry extends MovedEntry {
    birthtime?: string;
    device: string;
    inode: string;
}
type CreateMutationParameters = Omit<ServerOperationParameters<'files.create'>, 'operationId'> & {
    operationId?: string;
};
type RenameMutationParameters = Omit<ServerOperationParameters<'files.rename'>, 'operationId'> & {
    operationId?: string;
};
type MoveMutationParameters = Omit<ServerOperationParameters<'files.move'>, 'operationId'> & {
    operationId?: string;
};

interface ResolvedMutableEntry extends MutableEntry, FileIdentity {
    root: FileIdentity;
}

export interface FileMutationServiceOptions {
    /**
     * Test seam for replacing a source or parent after the durable stage write.
     */
    afterMutationStage?: () => Promise<void>;
    /**
     * Test seam for observing bounded validation after a recursive copy.
     */
    beforeCopyTargetValidation?: () => Promise<void>;
    /**
     * Test seam for replacing a destination after source preflight but before identity revalidation.
     */
    beforeCopyValidation?: () => Promise<void>;
    copyFile?: CopyFile;
    copyLimits?: Partial<CopyLimits>;
    now?: () => number;
}

const MAX_UNIQUE_NAME_ATTEMPTS = 100;
const MAX_FILE_NAME_BYTES = 255;

function fileName(name: string): string {
    const normalized = name.trim();
    if (
        !normalized ||
        normalized === '.' ||
        normalized === '..' ||
        normalized.length > 255 ||
        normalized.includes('/') ||
        normalized.includes('\\') ||
        normalized.includes('\0') ||
        Buffer.byteLength(normalized) > MAX_FILE_NAME_BYTES
    )
        throw new CaxriError('VALIDATION', 'Enter a valid file name without path separators');
    return normalized;
}

function suffixedName(source: ResolvedMutableEntry, sequence: number): string {
    if (sequence === 0) return source.name;
    const extension = source.kind === 'file' ? extname(source.name) : '';
    const stem = extension ? source.name.slice(0, -extension.length) : source.name;
    const suffix = sequence === 1 ? ' copy' : ` copy ${sequence}`;
    const tail = `${suffix}${extension}`;
    const availableBytes = MAX_FILE_NAME_BYTES - Buffer.byteLength(tail);
    if (availableBytes < 1)
        throw new CaxriError('VALIDATION', 'File name is too long to create a unique copy');
    let boundedStem = '';
    for (const character of stem) {
        if (Buffer.byteLength(boundedStem + character) > availableBytes) break;
        boundedStem += character;
    }
    return `${boundedStem || 'item'}${tail}`;
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

/**
 * Owns VS Code-style path-based Node file mutations under a Session's canonical Project root. Identities are
 * revalidated immediately before each call because Node has no directory-relative `openat`/no-replace rename API; Main
 * applies the same last-moment check before Electron Trash.
 */
export class FileMutationService {
    private readonly afterMutationStage?: () => Promise<void>;
    private readonly beforeCopyTargetValidation?: () => Promise<void>;
    private readonly beforeCopyValidation?: () => Promise<void>;
    private readonly copyLimits: CopyLimits;
    private readonly copyTree: CopyTreeExecutor;
    private readonly now: () => number;
    private readonly reservedTargets = new Set<string>();

    constructor(
        private readonly resolveSessionPath: ResolveSessionPath,
        private readonly logger: StructuredLogger,
        options: FileMutationServiceOptions = {},
    ) {
        this.afterMutationStage = options.afterMutationStage;
        this.beforeCopyTargetValidation = options.beforeCopyTargetValidation;
        this.beforeCopyValidation = options.beforeCopyValidation;
        this.copyLimits = { ...DEFAULT_COPY_LIMITS, ...options.copyLimits };
        this.now = options.now ?? (() => Date.now()); // Read per call, so later-installed fake timers apply.
        this.copyTree = new CopyTreeExecutor(
            this.now,
            this.copyLimits,
            options.copyFile ?? streamCopyFile,
        );
    }

    private async moveTo(
        sessionId: string,
        sourcePath: string,
        targetDirectoryPath?: string,
        requestedName?: string,
        conflict: 'reject' | 'rename' | 'replace' = 'reject',
        stage?: MutationStage<StagedMovedEntry>,
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

            const isRenameOnConflict = conflict === 'rename';
            const isReplaceOnConflict = conflict === 'replace';
            const sourceName = requestedName ?? basename(source.path);
            const directTargetPath = resolve(directory.path, sourceName);
            if (directTargetPath === source.path)
                return {
                    kind: source.kind,
                    name: sourceName,
                    path: source.path,
                    previousPath: source.path,
                };

            /**
             * This loop retries sequential candidate names until one is reserved and moved, then returns. Each
             * iteration depends on the previous one's reservation/existence outcome and the loop early-exits via
             * `return`/`continue`/`break`, so its awaits cannot be parallelized across iterations without racing target
             * reservations and the final `rename`.
             */
            for (let sequence = 0; sequence < MAX_UNIQUE_NAME_ATTEMPTS; sequence += 1) {
                if (!isRenameOnConflict && sequence > 0) break;
                const name = isRenameOnConflict ? suffixedName(source, sequence) : sourceName;
                const targetPath = resolve(directory.path, name);
                const release = this.tryReserveTarget(targetPath);
                if (!release) {
                    if (isRenameOnConflict) continue;
                    throw new CaxriError(
                        'CONFLICT',
                        'A file or folder with that name already exists',
                    );
                }
                try {
                    // eslint-disable-next-line no-await-in-loop -- see comment above the loop
                    if (!isReplaceOnConflict && (await isExistingPath(targetPath))) {
                        if (isRenameOnConflict) continue;
                        throw new CaxriError(
                            'CONFLICT',
                            'A file or folder with that name already exists',
                        );
                    }
                    // eslint-disable-next-line no-await-in-loop -- see comment above the loop
                    await Promise.all([
                        this.assertIdentity(source),
                        this.assertIdentity(directory),
                    ]);
                    const result: MovedEntry = {
                        kind: source.kind,
                        name,
                        path: targetPath,
                        previousPath: source.path,
                    };
                    // eslint-disable-next-line no-await-in-loop -- see comment above the loop
                    await stage?.({
                        ...result,
                        birthtime: source.birthtime,
                        device: source.device,
                        inode: source.inode,
                    });
                    // eslint-disable-next-line no-await-in-loop -- see comment above the loop
                    await this.afterMutationStage?.();
                    let isReplacedTarget = false;
                    if (isReplaceOnConflict) {
                        // eslint-disable-next-line no-await-in-loop -- see comment above the loop
                        isReplacedTarget = await this.assertReplaceableMove(source, targetPath);
                        // eslint-disable-next-line no-await-in-loop -- see comment above the loop
                    } else if (await isExistingPath(targetPath))
                        throw new CaxriError(
                            'CONFLICT',
                            'A file or folder with that name already exists',
                        );
                    // eslint-disable-next-line no-await-in-loop -- see comment above the loop
                    await Promise.all([
                        this.assertIdentity(source),
                        this.assertIdentity(directory),
                    ]);
                    /**
                     * Node's rename matches VS Code's local provider. The reservation prevents conflicting Caxri
                     * requests, and the final check normally avoids knowingly replacing a target that already exists:
                     * except in `replace` mode, where the caller already showed the user an interactive Finder-style
                     * prompt and captured an explicit Replace confirmation, and `assertReplaceableMove` just verified
                     * neither side of the move is a folder. Server has no Trash API for a safer overwrite (that lives
                     * in Main), so the sanctioned replace path is POSIX `rename(2)` atomically overwriting a plain file
                     * target.
                     */
                    // eslint-disable-next-line no-await-in-loop -- see comment above the loop
                    await rename(source.path, targetPath);
                    this.logger.write('info', logEventCatalog.file.moved, {
                        fields: {
                            sessionId,
                            from: relative(source.root.path, source.path),
                            to: relative(source.root.path, targetPath),
                            ...(isReplacedTarget && { replaced: true }),
                        },
                    });
                    return result;
                } finally {
                    release();
                }
            }
            throw new CaxriError(
                'CONFLICT',
                isRenameOnConflict
                    ? 'Unable to find an available move name'
                    : 'A file or folder with that name already exists',
            );
        } catch (error) {
            throw mutationError(error, requestedName ? 'renaming the item' : 'moving the item');
        }
    }

    /**
     * `replace` mode intentionally skips the CONFLICT-on-existing-target checks the other modes use: the caller already
     * showed the user a Finder-style prompt and captured an explicit Replace confirmation. The only remaining safety
     * rail is this directory check. Returns whether an existing file target was actually present (and is about to be
     * overwritten), so the caller can log it; a target that vanished between the user's choice and this retry (ENOENT)
     * is treated the same as no target: the plain rename below just succeeds.
     */
    private async assertReplaceableMove(
        source: FileIdentity,
        targetPath: string,
    ): Promise<boolean> {
        const [sourceStats, targetStats] = await Promise.all([
            lstat(source.path, { bigint: true }),
            (async () => {
                try {
                    return await lstat(targetPath, { bigint: true });
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
                    throw error;
                }
            })(),
        ]);
        if (sourceStats.isDirectory() || targetStats?.isDirectory())
            throw new CaxriError('CONFLICT', 'A folder cannot replace or be replaced');
        return targetStats !== undefined;
    }

    private reserveTarget(path: string): () => void {
        const release = this.tryReserveTarget(path);
        if (!release)
            throw new CaxriError('CONFLICT', 'A file or folder with that name already exists');
        return release;
    }

    private tryReserveTarget(path: string): (() => void) | undefined {
        if (this.reservedTargets.has(path)) return undefined;
        this.reservedTargets.add(path);
        return () => this.reservedTargets.delete(path);
    }

    private async assertIdentity(entry: ResolvedMutableEntry): Promise<void> {
        const stats = await lstat(entry.path, { bigint: true });
        if (
            stats.isSymbolicLink() ||
            stats.dev.toString() !== entry.device ||
            stats.ino.toString() !== entry.inode ||
            (stats.isFile() && stats.nlink > 1n) ||
            (!stats.isFile() && !stats.isDirectory())
        )
            throw new CaxriError('CONFLICT', 'File or folder changed before the operation started');
    }

    private async resolveExisting(
        sessionId: string,
        input: string,
        isRootAllowed = false,
    ): Promise<ResolvedMutableEntry> {
        const root = await this.resolveSessionPath(sessionId);
        const lexicalPath = isAbsolute(input) ? resolve(input) : resolve(root.root, input);
        const resolved = await this.resolveSessionPath(sessionId, lexicalPath);
        if (resolved.root !== root.root)
            throw new CaxriError('PATH_DENIED', 'Path is outside the Project root');
        const lexicalStats = await lstat(lexicalPath, { bigint: true });
        if (lexicalStats.isSymbolicLink())
            throw new CaxriError('PATH_DENIED', 'Symbolic links cannot be changed');
        if (!isRootAllowed && resolved.path === resolved.root)
            throw new CaxriError('PATH_DENIED', 'The Project root cannot be changed');
        const [stats, rootStats] = await Promise.all([
            lstat(resolved.path, { bigint: true }),
            lstat(resolved.root, { bigint: true }),
        ]);
        if (
            stats.isSymbolicLink() ||
            lexicalStats.dev !== stats.dev ||
            lexicalStats.ino !== stats.ino ||
            (stats.isFile() && stats.nlink > 1n) ||
            (!stats.isFile() && !stats.isDirectory())
        )
            throw new CaxriError('PATH_DENIED', 'Only regular files and folders can be changed');
        if (rootStats.isSymbolicLink() || !rootStats.isDirectory())
            throw new CaxriError('PATH_DENIED', 'Project root is no longer a directory');
        return {
            root: {
                path: resolved.root,
                device: rootStats.dev.toString(),
                inode: rootStats.ino.toString(),
            },
            path: resolved.path,
            name: basename(resolved.path),
            kind: stats.isDirectory() ? 'directory' : 'file',
            birthtime: stats.birthtimeNs.toString(),
            device: stats.dev.toString(),
            inode: stats.ino.toString(),
        };
    }

    async create(
        parameters: CreateMutationParameters,
        stage?: MutationStage<StagedCreatedEntry>,
    ): Promise<ServerOperationResult<'files.create'>> {
        try {
            const directory = await this.resolveExisting(
                parameters.sessionId,
                parameters.directory,
                true,
            );
            if (directory.kind !== 'directory')
                throw new CaxriError('IO', 'New files can only be created in a folder');
            const name = fileName(parameters.name);
            const path = resolve(directory.path, name);
            const release = this.reserveTarget(path);
            try {
                const result: MutableEntry = { kind: parameters.kind, name, path };
                await this.assertIdentity(directory);
                await stage?.(result);
                await this.afterMutationStage?.();
                await this.assertIdentity(directory);
                let identity: FileIdentity;
                if (parameters.kind === 'directory') {
                    await mkdir(path);
                    identity = await createdIdentity(path);
                } else {
                    const file = await open(path, 'wx');
                    try {
                        identity = await createdHandleIdentity(file, path);
                    } finally {
                        await file.close();
                    }
                }
                await stage?.({
                    ...result,
                    birthtime: identity.birthtime,
                    device: identity.device,
                    inode: identity.inode,
                });
                await assertPathIdentity(identity);
            } finally {
                release();
            }
            this.logger.write('info', logEventCatalog.file.created, {
                fields: {
                    sessionId: parameters.sessionId,
                    kind: parameters.kind,
                    path: relative(directory.root.path, path),
                },
            });
            return { kind: parameters.kind, name, path };
        } catch (error) {
            if (isStagedCreatePersistenceError(error)) throw error;
            throw mutationError(error, 'creating the item');
        }
    }

    async copy(
        parameters: ServerOperationParameters<'files.copy'>,
    ): Promise<ServerOperationResult<'files.copy'>> {
        const observedAt = performance.now();
        let phase = 'preflight';
        let entryCount = 0;
        let totalBytes = 0;
        let isPartialCopyPreserved = false;
        try {
            const source = await this.resolveExisting(parameters.sessionId, parameters.path);
            const directory = await this.resolveExisting(
                parameters.sessionId,
                parameters.directory,
                true,
            );
            if (directory.kind !== 'directory')
                throw new CaxriError('IO', 'Files can only be copied into a folder');
            if (source.kind === 'directory' && isSameOrInside(source.path, directory.path))
                throw new CaxriError('CONFLICT', 'A folder cannot be copied into itself');

            await Promise.all([this.assertIdentity(source), this.assertIdentity(directory)]);
            const startedAt = this.now();
            const controller = new AbortController();
            const deadline = setTimeout(
                () => controller.abort(),
                this.copyLimits.maximumDurationMs,
            );
            try {
                const manifest = await this.copyTree.inspectCopyTree(
                    source.path,
                    startedAt,
                    controller.signal,
                );
                entryCount = manifest.entries.length;
                totalBytes = manifest.totalBytes;
                await this.beforeCopyValidation?.();
                /**
                 * This loop retries sequential candidate names (`file copy`, `file copy 2`, ...) until one is free,
                 * then performs the actual transfer and returns. Each iteration depends on the previous one's outcome
                 * (name taken vs. free, transfer succeeded vs. conflicted) and the loop early-exits via
                 * `return`/`continue`, so the awaits below cannot be parallelized across iterations without racing
                 * target reservations and risking multiple concurrent transfers into the same candidate name.
                 */
                for (let sequence = 0; sequence < MAX_UNIQUE_NAME_ATTEMPTS; sequence += 1) {
                    this.copyTree.assertCopyDeadline(startedAt, controller.signal);
                    const name = suffixedName(source, sequence);
                    const path = resolve(directory.path, name);
                    const release = this.tryReserveTarget(path);
                    if (!release) continue;
                    const createdTargets: FileIdentity[] = [];
                    try {
                        // eslint-disable-next-line no-await-in-loop -- see comment above the loop
                        if (await isExistingPath(path)) continue;
                        // eslint-disable-next-line no-await-in-loop -- see comment above the loop
                        await Promise.all([
                            this.assertIdentity(source),
                            this.assertIdentity(directory),
                        ]);
                        phase = 'transfer';
                        // eslint-disable-next-line no-await-in-loop -- see comment above the loop
                        await this.copyTree.copyEntries(
                            manifest.entries,
                            path,
                            startedAt,
                            controller.signal,
                            () => this.assertIdentity(directory),
                            (target) => {
                                createdTargets.push(target);
                            },
                        );
                        // eslint-disable-next-line no-await-in-loop -- see comment above the loop
                        await mapWithConcurrency(
                            createdTargets,
                            MAX_CONCURRENT_COPY_VALIDATIONS,
                            async (target) => {
                                this.copyTree.assertCopyDeadline(startedAt, controller.signal);
                                await this.beforeCopyTargetValidation?.();
                                await assertPathIdentity(target);
                            },
                        );
                        this.copyTree.assertCopyDeadline(startedAt, controller.signal);
                        this.logger.write('info', logEventCatalog.file.copied, {
                            durationMs: performance.now() - observedAt,
                            fields: {
                                sessionId: parameters.sessionId,
                                from: relative(source.root.path, source.path),
                                to: relative(source.root.path, path),
                                entryCount,
                                totalBytes,
                            },
                        });
                        return { kind: source.kind, name, path };
                    } catch (error) {
                        if (
                            (error as NodeJS.ErrnoException).code === 'EEXIST' &&
                            createdTargets.length === 0
                        )
                            continue;
                        if (createdTargets.length > 0) {
                            isPartialCopyPreserved = true;
                            this.logger.write('warn', logEventCatalog.file.copyPartialPreserved, {
                                fields: { entryCount: createdTargets.length },
                            });
                        }
                        throw error;
                    } finally {
                        release();
                    }
                }
                throw new CaxriError('CONFLICT', 'Unable to find an available copy name');
            } catch (error) {
                if (controller.signal.aborted)
                    throw new CaxriError('TIMEOUT', 'Copy exceeded the file operation time limit');
                throw error;
            } finally {
                clearTimeout(deadline);
            }
        } catch (error) {
            this.logger.write('warn', logEventCatalog.file.copyFailed, {
                durationMs: performance.now() - observedAt,
                fields: {
                    sessionId: parameters.sessionId,
                    phase,
                    entryCount,
                    totalBytes,
                    code:
                        (isCaxriError(error) ? error.code : undefined) ??
                        (error as NodeJS.ErrnoException).code ??
                        'IO',
                },
            });
            const failure = mutationError(error, 'copying the item');
            if (isPartialCopyPreserved)
                throw new CaxriError(
                    failure.code,
                    `${failure.message}. The partial copy was kept to avoid deleting files changed by another app.`,
                );
            throw failure;
        }
    }

    rename(
        parameters: RenameMutationParameters,
        stage?: MutationStage<StagedMovedEntry>,
    ): Promise<ServerOperationResult<'files.rename'>> {
        return this.moveTo(
            parameters.sessionId,
            parameters.path,
            undefined,
            fileName(parameters.name),
            'reject',
            stage,
        );
    }

    move(
        parameters: MoveMutationParameters,
        stage?: MutationStage<StagedMovedEntry>,
    ): Promise<ServerOperationResult<'files.move'>> {
        return this.moveTo(
            parameters.sessionId,
            parameters.path,
            parameters.directory,
            undefined,
            parameters.conflict,
            stage,
        );
    }

    async authorizeTrash(
        parameters: ServerOperationParameters<'files.authorizeTrash'>,
    ): Promise<ServerOperationResult<'files.authorizeTrash'>> {
        const entry = await this.resolveExisting(parameters.sessionId, parameters.path);
        return {
            kind: entry.kind,
            name: entry.name,
            path: entry.path,
            device: entry.device,
            inode: entry.inode,
            root: entry.root,
        };
    }
}
