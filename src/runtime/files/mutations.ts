import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, type FileHandle } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { CaxriError, isCaxriError } from '../../shared/ipc/errors';
import type { RuntimeMethodParams, RuntimeMethodResult } from '../../shared/ipc/methods';
import { mapWithConcurrency } from '../../shared/node/concurrency';
import type { StructuredLogger } from '../../shared/node/logger';
import type { ResolveSessionPath } from './documents';

type MutableEntry = RuntimeMethodResult<'files.create'>;
type MovedEntry = RuntimeMethodResult<'files.rename'>;
type MutationStage<Result> = (expectedResult: Result) => Promise<void>;
interface StagedCreatedEntry extends MutableEntry {
    device?: string;
    inode?: string;
}
interface StagedMovedEntry extends MovedEntry {
    device: string;
    inode: string;
}
type CreateMutationParams = Omit<RuntimeMethodParams<'files.create'>, 'operationId'> & {
    operationId?: string;
};
type RenameMutationParams = Omit<RuntimeMethodParams<'files.rename'>, 'operationId'> & {
    operationId?: string;
};
type MoveMutationParams = Omit<RuntimeMethodParams<'files.move'>, 'operationId'> & {
    operationId?: string;
};

interface FileIdentity {
    device: string;
    inode: string;
    path: string;
}

interface ResolvedMutableEntry extends MutableEntry, FileIdentity {
    root: FileIdentity;
}

interface CopyLimits {
    maximumBytes: number;
    maximumDurationMs: number;
    maximumEntries: number;
}

interface CopyBudget {
    bytes: number;
    entries: number;
    startedAt: number;
}

interface CopyEntry extends FileIdentity {
    kind: 'directory' | 'file';
    mode: number;
    relativePath: string;
}

interface CopyManifest {
    entries: CopyEntry[];
    totalBytes: number;
}

interface CopyFileOptions {
    signal: AbortSignal;
}

type CopyFile = (source: FileHandle, target: FileHandle, options: CopyFileOptions) => Promise<void>;

export interface FileMutationServiceOptions {
    /** Test seam for replacing a source or parent after the durable stage write. */
    afterMutationStage?: () => Promise<void>;
    /** Test seam for observing bounded validation after a recursive copy. */
    beforeCopyTargetValidation?: () => Promise<void>;
    /** Test seam for replacing a destination after source preflight but before identity revalidation. */
    beforeCopyValidation?: () => Promise<void>;
    copyFile?: CopyFile;
    copyLimits?: Partial<CopyLimits>;
    now?: () => number;
}

const MAX_UNIQUE_NAME_ATTEMPTS = 100;
const MAX_FILE_NAME_BYTES = 255;
const MAX_CONCURRENT_COPY_VALIDATIONS = 32;
const DEFAULT_COPY_LIMITS: CopyLimits = {
    maximumBytes: 20 * 1024 * 1024 * 1024,
    maximumDurationMs: 5 * 60_000,
    maximumEntries: 100_000,
};

async function streamCopyFile(
    source: FileHandle,
    target: FileHandle,
    options: CopyFileOptions,
): Promise<void> {
    await pipeline(source.createReadStream(), target.createWriteStream(), {
        signal: options.signal,
    });
}

function fileName(name: string): string {
    const normalized = name.trim();
    if (
        !normalized ||
        normalized.length > 255 ||
        Buffer.byteLength(normalized) > MAX_FILE_NAME_BYTES ||
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
 * Owns VS Code-style path-based Node file mutations under a Session's canonical Project root.
 * Identities are revalidated immediately before each call because Node has no directory-relative
 * `openat`/no-replace rename API; Main applies the same last-moment check before Electron Trash.
 */
export class FileMutationService {
    private readonly afterMutationStage?: () => Promise<void>;
    private readonly beforeCopyTargetValidation?: () => Promise<void>;
    private readonly beforeCopyValidation?: () => Promise<void>;
    private readonly copyFile: CopyFile;
    private readonly copyLimits: CopyLimits;
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
        this.copyFile = options.copyFile ?? streamCopyFile;
        this.copyLimits = { ...DEFAULT_COPY_LIMITS, ...options.copyLimits };
        this.now = options.now ?? Date.now;
    }

    async create(
        params: CreateMutationParams,
        stage?: MutationStage<StagedCreatedEntry>,
    ): Promise<RuntimeMethodResult<'files.create'>> {
        try {
            const directory = await this.resolveExisting(params.sessionId, params.directory, true);
            if (directory.kind !== 'directory')
                throw new CaxriError('IO', 'New files can only be created in a folder');
            const name = fileName(params.name);
            const path = resolve(directory.path, name);
            const release = this.reserveTarget(path);
            try {
                const result: MutableEntry = { kind: params.kind, name, path };
                await this.assertIdentity(directory);
                await stage?.(result);
                await this.afterMutationStage?.();
                await this.assertIdentity(directory);
                let identity: FileIdentity;
                if (params.kind === 'directory') {
                    await mkdir(path);
                    identity = await this.createdIdentity(path);
                } else {
                    const file = await open(path, 'wx');
                    try {
                        identity = await this.createdHandleIdentity(file, path);
                    } finally {
                        await file.close();
                    }
                }
                await stage?.({ ...result, device: identity.device, inode: identity.inode });
                await this.assertPathIdentity(identity);
            } finally {
                release();
            }
            this.logger.write('info', 'file.created', {
                fields: {
                    sessionId: params.sessionId,
                    kind: params.kind,
                    path: relative(directory.root.path, path),
                },
            });
            return { kind: params.kind, name, path };
        } catch (error) {
            throw mutationError(error, 'creating the item');
        }
    }

    async copy(
        params: RuntimeMethodParams<'files.copy'>,
    ): Promise<RuntimeMethodResult<'files.copy'>> {
        const observedAt = performance.now();
        let phase = 'preflight';
        let entryCount = 0;
        let totalBytes = 0;
        let partialCopyPreserved = false;
        try {
            const source = await this.resolveExisting(params.sessionId, params.path);
            const directory = await this.resolveExisting(params.sessionId, params.directory, true);
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
                const manifest = await this.inspectCopyTree(
                    source.path,
                    startedAt,
                    controller.signal,
                );
                entryCount = manifest.entries.length;
                totalBytes = manifest.totalBytes;
                await this.beforeCopyValidation?.();
                for (let sequence = 0; sequence < MAX_UNIQUE_NAME_ATTEMPTS; sequence += 1) {
                    this.assertCopyDeadline(startedAt, controller.signal);
                    const name = suffixedName(source, sequence);
                    const path = resolve(directory.path, name);
                    const release = this.tryReserveTarget(path);
                    if (!release) continue;
                    const createdTargets: FileIdentity[] = [];
                    try {
                        if (await this.pathExists(path)) continue;
                        await Promise.all([
                            this.assertIdentity(source),
                            this.assertIdentity(directory),
                        ]);
                        phase = 'transfer';
                        await this.copyEntries(
                            manifest.entries,
                            path,
                            directory,
                            startedAt,
                            controller.signal,
                            (target) => createdTargets.push(target),
                        );
                        await mapWithConcurrency(
                            createdTargets,
                            MAX_CONCURRENT_COPY_VALIDATIONS,
                            async (target) => {
                                this.assertCopyDeadline(startedAt, controller.signal);
                                await this.beforeCopyTargetValidation?.();
                                await this.assertPathIdentity(target);
                            },
                        );
                        this.assertCopyDeadline(startedAt, controller.signal);
                        this.logger.write('info', 'file.copied', {
                            durationMs: performance.now() - observedAt,
                            fields: {
                                sessionId: params.sessionId,
                                from: relative(source.root.path, source.path),
                                to: relative(source.root.path, path),
                                entryCount,
                                totalBytes,
                            },
                        });
                        return { kind: source.kind, name, path };
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
                            if (createdTargets.length === 0) continue;
                        }
                        if (createdTargets.length > 0) {
                            partialCopyPreserved = true;
                            this.logger.write('warn', 'file.copy_partial_preserved', {
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
            this.logger.write('warn', 'file.copy_failed', {
                durationMs: performance.now() - observedAt,
                fields: {
                    sessionId: params.sessionId,
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
            if (partialCopyPreserved)
                throw new CaxriError(
                    failure.code,
                    `${failure.message}. The partial copy was kept to avoid deleting files changed by another app.`,
                );
            throw failure;
        }
    }

    rename(
        params: RenameMutationParams,
        stage?: MutationStage<StagedMovedEntry>,
    ): Promise<RuntimeMethodResult<'files.rename'>> {
        return this.moveTo(
            params.sessionId,
            params.path,
            undefined,
            fileName(params.name),
            false,
            stage,
        );
    }

    move(
        params: MoveMutationParams,
        stage?: MutationStage<StagedMovedEntry>,
    ): Promise<RuntimeMethodResult<'files.move'>> {
        return this.moveTo(
            params.sessionId,
            params.path,
            params.directory,
            undefined,
            params.conflict === 'rename',
            stage,
        );
    }

    async authorizeOpen(
        params: RuntimeMethodParams<'files.authorizeOpen'>,
    ): Promise<RuntimeMethodResult<'files.authorizeOpen'>> {
        const entry = await this.resolveExisting(params.sessionId, params.path, true);
        return { kind: entry.kind, name: entry.name, path: entry.path };
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
        renameOnConflict = false,
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

            const sourceName = requestedName ?? basename(source.path);
            const directTargetPath = resolve(directory.path, sourceName);
            if (directTargetPath === source.path)
                return {
                    kind: source.kind,
                    name: sourceName,
                    path: source.path,
                    previousPath: source.path,
                };

            for (let sequence = 0; sequence < MAX_UNIQUE_NAME_ATTEMPTS; sequence += 1) {
                if (!renameOnConflict && sequence > 0) break;
                const name = renameOnConflict ? suffixedName(source, sequence) : sourceName;
                const targetPath = resolve(directory.path, name);
                const release = this.tryReserveTarget(targetPath);
                if (!release) {
                    if (renameOnConflict) continue;
                    throw new CaxriError(
                        'CONFLICT',
                        'A file or folder with that name already exists',
                    );
                }
                try {
                    if (await this.pathExists(targetPath)) {
                        if (renameOnConflict) continue;
                        throw new CaxriError(
                            'CONFLICT',
                            'A file or folder with that name already exists',
                        );
                    }
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
                    await stage?.({ ...result, device: source.device, inode: source.inode });
                    await this.afterMutationStage?.();
                    if (await this.pathExists(targetPath))
                        throw new CaxriError(
                            'CONFLICT',
                            'A file or folder with that name already exists',
                        );
                    await Promise.all([
                        this.assertIdentity(source),
                        this.assertIdentity(directory),
                    ]);
                    /**
                     * Node's rename matches VS Code's local provider. The reservation prevents
                     * conflicting Caxri requests, while the final check avoids knowingly replacing
                     * a target that already exists.
                     */
                    await rename(source.path, targetPath);
                    this.logger.write('info', 'file.moved', {
                        fields: {
                            sessionId,
                            from: relative(source.root.path, source.path),
                            to: relative(source.root.path, targetPath),
                        },
                    });
                    return result;
                } finally {
                    release();
                }
            }
            throw new CaxriError(
                'CONFLICT',
                renameOnConflict
                    ? 'Unable to find an available move name'
                    : 'A file or folder with that name already exists',
            );
        } catch (error) {
            throw mutationError(error, requestedName ? 'renaming the item' : 'moving the item');
        }
    }

    private reserveTarget(path: string): () => void {
        const release = this.tryReserveTarget(path);
        if (!release)
            throw new CaxriError('CONFLICT', 'A file or folder with that name already exists');
        return release;
    }

    /** Validates the whole source before native writes can leave a partial target. */
    private async inspectCopyTree(
        source: string,
        startedAt: number,
        signal: AbortSignal,
    ): Promise<CopyManifest> {
        const budget: CopyBudget = { bytes: 0, entries: 0, startedAt };
        const pending = [source];
        const entries: CopyEntry[] = [];
        while (pending.length > 0) {
            const candidate = pending.pop();
            if (!candidate) break;
            this.assertCopyDeadline(startedAt, signal);
            const stats = await this.inspectCopyEntry(candidate, budget);
            entries.push({
                path: candidate,
                relativePath: relative(source, candidate),
                kind: stats.isDirectory() ? 'directory' : 'file',
                mode: Number(stats.mode),
                device: stats.dev.toString(),
                inode: stats.ino.toString(),
            });
            if (!stats.isDirectory()) continue;
            const names = await readdir(candidate);
            for (const name of names) pending.push(resolve(candidate, name));
        }
        return { entries, totalBytes: budget.bytes };
    }

    private async inspectCopyEntry(candidate: string, budget: CopyBudget): Promise<BigIntStats> {
        const stats = await lstat(candidate, { bigint: true });
        if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory()))
            throw new CaxriError('PATH_DENIED', 'Only regular files and folders can be copied');
        if (stats.isFile() && stats.nlink > 1n)
            throw new CaxriError(
                'PATH_DENIED',
                'Files with multiple filesystem links cannot be copied',
            );
        budget.entries += 1;
        if (stats.isFile()) budget.bytes += Number(stats.size);
        if (budget.entries > this.copyLimits.maximumEntries)
            throw new CaxriError(
                'CAPACITY',
                `Copy exceeds the ${this.copyLimits.maximumEntries} entry safety limit`,
            );
        if (budget.bytes > this.copyLimits.maximumBytes)
            throw new CaxriError(
                'CAPACITY',
                `Copy exceeds the ${this.copyLimits.maximumBytes} byte safety limit`,
            );
        if (this.now() - budget.startedAt > this.copyLimits.maximumDurationMs)
            throw new CaxriError('TIMEOUT', 'Copy exceeded the file operation time limit');
        return stats;
    }

    private async copyEntries(
        entries: readonly CopyEntry[],
        targetRoot: string,
        destination: ResolvedMutableEntry,
        startedAt: number,
        signal: AbortSignal,
        onTargetCreated: (target: FileIdentity) => void,
    ): Promise<void> {
        const targetDirectories = new Map<string, FileIdentity>();
        for (const entry of entries) {
            this.assertCopyDeadline(startedAt, signal);
            await Promise.all([
                this.assertCopyEntryIdentity(entry),
                this.assertIdentity(destination),
            ]);
            const targetPath = entry.relativePath
                ? resolve(targetRoot, entry.relativePath)
                : targetRoot;
            const parentIdentity = targetDirectories.get(dirname(targetPath));
            if (parentIdentity) await this.assertPathIdentity(parentIdentity);

            if (entry.kind === 'directory') {
                await mkdir(targetPath, { mode: (entry.mode & 0o777) | 0o700 });
                const identity = await this.createdIdentity(targetPath);
                targetDirectories.set(targetPath, identity);
                onTargetCreated(identity);
                this.assertCopyDeadline(startedAt, signal);
                continue;
            }

            const source = await open(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW);
            let target: FileHandle | undefined;
            try {
                await this.assertOpenFileIdentity(source, entry);
                target = await open(
                    targetPath,
                    constants.O_WRONLY |
                        constants.O_CREAT |
                        constants.O_EXCL |
                        constants.O_NOFOLLOW,
                    entry.mode,
                );
                const identity = await this.createdHandleIdentity(target, targetPath);
                onTargetCreated(identity);
                await target.chmod(entry.mode & 0o777);
                await this.copyFile(source, target, { signal });
                this.assertCopyDeadline(startedAt, signal);
            } finally {
                await Promise.allSettled([source.close(), target?.close()]);
            }
        }
        for (const entry of [...entries].reverse()) {
            this.assertCopyDeadline(startedAt, signal);
            if (entry.kind !== 'directory') continue;
            const targetPath = entry.relativePath
                ? resolve(targetRoot, entry.relativePath)
                : targetRoot;
            const identity = targetDirectories.get(targetPath);
            /** Descendants must retain traversal permission until their modes are restored. */
            // oxlint-disable-next-line react-doctor/async-await-in-loop
            if (identity) await this.chmodCreatedDirectory(identity, entry.mode & 0o777);
        }
        this.assertCopyDeadline(startedAt, signal);
    }

    private assertCopyDeadline(startedAt: number, signal: AbortSignal): void {
        if (signal.aborted || this.now() - startedAt > this.copyLimits.maximumDurationMs)
            throw new CaxriError('TIMEOUT', 'Copy exceeded the file operation time limit');
    }

    private async assertCopyEntryIdentity(entry: CopyEntry): Promise<void> {
        const stats = await lstat(entry.path, { bigint: true });
        if (
            stats.isSymbolicLink() ||
            stats.dev.toString() !== entry.device ||
            stats.ino.toString() !== entry.inode ||
            (entry.kind === 'file' && (!stats.isFile() || stats.nlink > 1n)) ||
            (entry.kind === 'directory' && !stats.isDirectory())
        )
            throw new CaxriError('CONFLICT', 'File or folder changed while it was being copied');
    }

    private async assertOpenFileIdentity(file: FileHandle, entry: CopyEntry): Promise<void> {
        const stats = await file.stat({ bigint: true });
        if (
            !stats.isFile() ||
            stats.dev.toString() !== entry.device ||
            stats.ino.toString() !== entry.inode ||
            stats.nlink > 1n
        )
            throw new CaxriError('CONFLICT', 'File changed while it was being copied');
    }

    private async createdIdentity(path: string): Promise<FileIdentity> {
        const stats = await lstat(path, { bigint: true });
        return { path, device: stats.dev.toString(), inode: stats.ino.toString() };
    }

    private async createdHandleIdentity(file: FileHandle, path: string): Promise<FileIdentity> {
        const stats = await file.stat({ bigint: true });
        return { path, device: stats.dev.toString(), inode: stats.ino.toString() };
    }

    private async assertPathIdentity(identity: FileIdentity): Promise<void> {
        const stats = await lstat(identity.path, { bigint: true });
        if (
            stats.isSymbolicLink() ||
            stats.dev.toString() !== identity.device ||
            stats.ino.toString() !== identity.inode
        )
            throw new CaxriError('CONFLICT', 'Copy destination changed during the operation');
    }

    private async chmodCreatedDirectory(identity: FileIdentity, mode: number): Promise<void> {
        await this.assertPathIdentity(identity);
        const directory = await open(identity.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            const stats = await directory.stat({ bigint: true });
            if (
                !stats.isDirectory() ||
                stats.dev.toString() !== identity.device ||
                stats.ino.toString() !== identity.inode
            )
                throw new CaxriError('CONFLICT', 'Copy destination changed during the operation');
            await directory.chmod(mode);
        } finally {
            await directory.close();
        }
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

    private async pathExists(path: string): Promise<boolean> {
        try {
            await lstat(path);
            return true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
            throw error;
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
            device: stats.dev.toString(),
            inode: stats.ino.toString(),
        };
    }
}
