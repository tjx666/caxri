import type { CopyOptions, Stats } from 'node:fs';
import { cp, lstat, mkdir, open, readdir, rename } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';

import { CaxriError, isCaxriError } from '../../shared/ipc/errors';
import type { RuntimeMethodParams, RuntimeMethodResult } from '../../shared/ipc/methods';
import type { StructuredLogger } from '../../shared/node/logger';
import type { ResolveSessionPath } from './documents';

type MutableEntry = RuntimeMethodResult<'files.create'>;
type MovedEntry = RuntimeMethodResult<'files.rename'>;

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

type CopyFile = (source: string, target: string, options: CopyOptions) => Promise<void>;

export interface FileMutationServiceOptions {
    copyFile?: CopyFile;
    copyLimits?: Partial<CopyLimits>;
    now?: () => number;
}

const MAX_UNIQUE_NAME_ATTEMPTS = 100;
const MAX_FILE_NAME_BYTES = 255;
const DEFAULT_COPY_LIMITS: CopyLimits = {
    maximumBytes: 20 * 1024 * 1024 * 1024,
    maximumDurationMs: 5 * 60_000,
    maximumEntries: 100_000,
};

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
    private readonly copyFile: CopyFile;
    private readonly copyLimits: CopyLimits;
    private readonly now: () => number;
    private readonly reservedTargets = new Set<string>();

    constructor(
        private readonly resolveSessionPath: ResolveSessionPath,
        private readonly logger: StructuredLogger,
        options: FileMutationServiceOptions = {},
    ) {
        this.copyFile = options.copyFile ?? cp;
        this.copyLimits = { ...DEFAULT_COPY_LIMITS, ...options.copyLimits };
        this.now = options.now ?? Date.now;
    }

    async create(
        params: RuntimeMethodParams<'files.create'>,
    ): Promise<RuntimeMethodResult<'files.create'>> {
        try {
            const directory = await this.resolveExisting(params.sessionId, params.directory, true);
            if (directory.kind !== 'directory')
                throw new CaxriError('IO', 'New files can only be created in a folder');
            const name = fileName(params.name);
            const path = resolve(directory.path, name);
            const release = this.reserveTarget(path);
            try {
                await this.assertIdentity(directory);
                if (params.kind === 'directory') await mkdir(path);
                else await (await open(path, 'wx')).close();
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
        try {
            const source = await this.resolveExisting(params.sessionId, params.path);
            const directory = await this.resolveExisting(params.sessionId, params.directory, true);
            if (directory.kind !== 'directory')
                throw new CaxriError('IO', 'Files can only be copied into a folder');
            if (source.kind === 'directory' && isSameOrInside(source.path, directory.path))
                throw new CaxriError('CONFLICT', 'A folder cannot be copied into itself');

            await Promise.all([this.assertIdentity(source), this.assertIdentity(directory)]);
            const startedAt = this.now();
            await this.inspectCopyTree(source.path, startedAt);
            for (let sequence = 0; sequence < MAX_UNIQUE_NAME_ATTEMPTS; sequence += 1) {
                const name = suffixedName(source, sequence);
                const path = resolve(directory.path, name);
                const release = this.tryReserveTarget(path);
                if (!release) continue;
                try {
                    if (await this.pathExists(path)) continue;
                    const copyBudget: CopyBudget = { bytes: 0, entries: 0, startedAt };
                    await this.copyFile(source.path, path, {
                        dereference: false,
                        errorOnExist: true,
                        force: false,
                        recursive: true,
                        verbatimSymlinks: true,
                        filter: async (candidate) => {
                            await this.inspectCopyEntry(candidate, copyBudget);
                            return true;
                        },
                    });
                    this.logger.write('info', 'file.copied', {
                        fields: {
                            sessionId: params.sessionId,
                            from: relative(source.root.path, source.path),
                            to: relative(source.root.path, path),
                        },
                    });
                    return { kind: source.kind, name, path };
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                } finally {
                    release();
                }
            }
            throw new CaxriError('CONFLICT', 'Unable to find an available copy name');
        } catch (error) {
            throw mutationError(error, 'copying the item');
        }
    }

    rename(
        params: RuntimeMethodParams<'files.rename'>,
    ): Promise<RuntimeMethodResult<'files.rename'>> {
        return this.moveTo(params.sessionId, params.path, undefined, fileName(params.name));
    }

    move(params: RuntimeMethodParams<'files.move'>): Promise<RuntimeMethodResult<'files.move'>> {
        return this.moveTo(
            params.sessionId,
            params.path,
            params.directory,
            undefined,
            params.conflict === 'rename',
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
                    return {
                        kind: source.kind,
                        name,
                        path: targetPath,
                        previousPath: source.path,
                    };
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

    /** Validates the whole source before `cp` can leave a partial target on a known rejection. */
    private async inspectCopyTree(source: string, startedAt: number): Promise<void> {
        const budget: CopyBudget = { bytes: 0, entries: 0, startedAt };
        const pending = [source];
        while (pending.length > 0) {
            const candidate = pending.pop();
            if (!candidate) break;
            const stats = await this.inspectCopyEntry(candidate, budget);
            if (!stats.isDirectory()) continue;
            const names = await readdir(candidate);
            for (const name of names) pending.push(resolve(candidate, name));
        }
    }

    private async inspectCopyEntry(candidate: string, budget: CopyBudget): Promise<Stats> {
        const stats = await lstat(candidate);
        if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory()))
            throw new CaxriError('PATH_DENIED', 'Only regular files and folders can be copied');
        if (stats.isFile() && stats.nlink > 1)
            throw new CaxriError(
                'PATH_DENIED',
                'Files with multiple filesystem links cannot be copied',
            );
        budget.entries += 1;
        if (stats.isFile()) budget.bytes += stats.size;
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
