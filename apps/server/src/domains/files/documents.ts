import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';

import type { FileAsset, FileDocument, ServerOperationResult } from '@caxri/protocol';
import { CaxriError, previewAssetByteLimit, previewAssetMediaType } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import { formatBytes } from '@caxri/utils';

import type { ResolvedSessionPath } from '../project';

export type ResolveSessionPath = (
    sessionId: string,
    input?: string,
) => Promise<ResolvedSessionPath>;

export type OpenFile = (path: string, flags: number, mode?: number) => ReturnType<typeof open>;
export type ReplaceFile = typeof rename;

export interface DocumentServiceOptions {
    /**
     * Integration-test seam for replacing the target after the new bytes are durable.
     */
    beforeReplaceValidation?: () => Promise<void>;
    openFile?: OpenFile;
    replaceFile?: ReplaceFile;
}

async function removeTrustedTemporaryFile(
    temporaryPath: string,
    openedStats: Stats | undefined,
): Promise<void> {
    if (!openedStats) return;
    try {
        const currentStats = await lstat(temporaryPath);
        /**
         * Cleanup is path-based too. Refuse to unlink unless the path still resolves to the exact inode Caxri created,
         * so a swapped parent cannot redirect cleanup to a foreign file.
         */
        if (
            currentStats.isSymbolicLink() ||
            !currentStats.isFile() ||
            currentStats.dev !== openedStats.dev ||
            currentStats.ino !== openedStats.ino ||
            currentStats.nlink > 1
        )
            return;
        await unlink(temporaryPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
}

/**
 * Use the workspace entry identity so a linked dependency remains view-only without locking its source Project.
 */
function isDependencyDocument(resolved: ResolvedSessionPath): boolean {
    return relative(resolved.root, resolved.workspacePath ?? resolved.path)
        .split(sep)
        .includes('node_modules');
}

/**
 * Reads and writes text documents reached through a Session's Project root with validated file handles.
 */
export class DocumentService {
    private readonly beforeReplaceValidation?: () => Promise<void>;
    private readonly openFile: OpenFile;
    private readonly replaceFile: ReplaceFile;

    constructor(
        private readonly resolveSessionPath: ResolveSessionPath,
        private readonly logger: StructuredLogger,
        private readonly maxFileBytes: () => number,
        options: DocumentServiceOptions = {},
    ) {
        this.beforeReplaceValidation = options.beforeReplaceValidation;
        this.openFile = options.openFile ?? open;
        this.replaceFile = options.replaceFile ?? rename;
    }

    /**
     * A queued operation must keep its original target while holding that target's queue slot.
     */
    private async resolveDocumentPath(
        sessionId: string,
        path: string,
        expected?: ResolvedSessionPath,
    ): Promise<ResolvedSessionPath> {
        const resolved = await this.resolveSessionPath(sessionId, path);
        if (expected && (resolved.path !== expected.path || resolved.root !== expected.root))
            throw new CaxriError('CONFLICT', 'File target changed during the operation');
        return resolved;
    }

    /**
     * Authorizes navigation using the workspace alias while identifying its actual target.
     */
    async authorizeOpen(
        sessionId: string,
        path: string,
        expected?: ResolvedSessionPath,
    ): Promise<ServerOperationResult<'files.authorizeOpen'>> {
        const resolved = await this.resolveDocumentPath(sessionId, path, expected);
        const [stats, rootStats] = await Promise.all([
            lstat(resolved.path, { bigint: true }),
            lstat(resolved.root, { bigint: true }),
        ]);
        if ((!stats.isDirectory() && !stats.isFile()) || (stats.isFile() && stats.nlink > 1n))
            throw new CaxriError('PATH_DENIED', 'Only regular files and folders can be opened');
        if (rootStats.isSymbolicLink() || !rootStats.isDirectory())
            throw new CaxriError('PATH_DENIED', 'Project root changed during authorization');
        const workspacePath = resolved.workspacePath ?? resolved.path;
        return {
            root: {
                path: resolved.root,
                device: rootStats.dev.toString(),
                inode: rootStats.ino.toString(),
            },
            path: workspacePath,
            name: basename(workspacePath),
            kind: stats.isDirectory() ? 'directory' : 'file',
            device: stats.dev.toString(),
            inode: stats.ino.toString(),
        };
    }

    async read(
        sessionId: string,
        path: string,
        signal?: AbortSignal,
        expected?: ResolvedSessionPath,
    ): Promise<FileDocument> {
        signal?.throwIfAborted();
        const resolved = await this.resolveDocumentPath(sessionId, path, expected);
        signal?.throwIfAborted();
        const isReadOnlyDependency = isDependencyDocument(resolved);
        const stats = await lstat(resolved.path);
        if (!stats.isFile() || stats.isSymbolicLink())
            throw new CaxriError('IO', 'Path is not a file');
        const file = await this.openFile(resolved.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            if ((await realpath(resolved.path)) !== resolved.path)
                throw new CaxriError('IO', 'File path changed during read');
            const openedStats = await file.stat();
            /**
             * Pnpm may hard-link package-store files. Authorized dependency entries are view-only; inode checks still
             * reject replacement and write() refuses their workspace identities before any mutation.
             */
            if (
                !openedStats.isFile() ||
                openedStats.dev !== stats.dev ||
                openedStats.ino !== stats.ino ||
                (!isReadOnlyDependency && openedStats.nlink > 1)
            ) {
                throw new CaxriError(
                    'IO',
                    'File changed during read or has multiple filesystem links',
                );
            }
            if (openedStats.size > this.maxFileBytes())
                throw new CaxriError(
                    'CAPACITY',
                    `File exceeds the ${formatBytes(this.maxFileBytes())} safety limit`,
                );
            const buffer = await file.readFile(signal ? { signal } : undefined);
            if (buffer.subarray(0, 8_192).includes(0))
                throw new CaxriError('IO', 'Binary files cannot be opened in the editor');
            return {
                path: resolved.workspacePath ?? resolved.path,
                content: buffer.toString('utf8'),
                mtimeMs: openedStats.mtimeMs,
                size: openedStats.size,
                ...(isReadOnlyDependency && { readOnly: true }),
            };
        } finally {
            await file.close();
        }
    }

    /**
     * Reads an image or PDF a preview surface shows.
     *
     * Shares `read`'s authorization and handle validation, and differs only where binary content demands it: no UTF-8
     * decode, no NUL-byte rejection, a per-media-type size ceiling, and a media type derived from the extension rather
     * than from anything the caller sent. Extensions outside the allowlist are refused before the file is opened, so a
     * document cannot use a preview to pull arbitrary bytes into the Renderer.
     */
    async readAsset(
        sessionId: string,
        path: string,
        signal?: AbortSignal,
        expected?: ResolvedSessionPath,
    ): Promise<FileAsset> {
        signal?.throwIfAborted();
        const resolved = await this.resolveDocumentPath(sessionId, path, expected);
        const mediaType = previewAssetMediaType(resolved.path);
        if (!mediaType) throw new CaxriError('PATH_DENIED', 'File type cannot be previewed');
        signal?.throwIfAborted();
        const stats = await lstat(resolved.path);
        if (!stats.isFile() || stats.isSymbolicLink())
            throw new CaxriError('IO', 'Path is not a file');
        const file = await this.openFile(resolved.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            if ((await realpath(resolved.path)) !== resolved.path)
                throw new CaxriError('IO', 'File path changed during read');
            const openedStats = await file.stat();
            if (
                !openedStats.isFile() ||
                openedStats.dev !== stats.dev ||
                openedStats.ino !== stats.ino ||
                openedStats.nlink > 1
            )
                throw new CaxriError(
                    'IO',
                    'File changed during read or has multiple filesystem links',
                );
            const limit = previewAssetByteLimit(mediaType);
            if (openedStats.size > limit)
                throw new CaxriError(
                    'CAPACITY',
                    `File exceeds the ${formatBytes(limit)} preview limit`,
                );
            const buffer = await file.readFile(signal ? { signal } : undefined);
            return {
                path: resolved.workspacePath ?? resolved.path,
                mediaType,
                base64: buffer.toString('base64'),
                size: openedStats.size,
            };
        } finally {
            await file.close();
        }
    }

    async write(
        sessionId: string,
        path: string,
        content: string,
        expected?: ResolvedSessionPath,
        expectedContentHash?: string,
    ): Promise<FileDocument> {
        const resolved = await this.resolveDocumentPath(sessionId, path, expected);
        if (isDependencyDocument(resolved))
            throw new CaxriError('FORBIDDEN', 'Dependency files are read-only');
        const stats = await lstat(resolved.path);
        if (!stats.isFile() || stats.isSymbolicLink())
            throw new CaxriError('IO', 'Only existing regular files can be saved');
        if (Buffer.byteLength(content, 'utf8') > this.maxFileBytes())
            throw new CaxriError('CAPACITY', 'Edited file exceeds the write safety limit');
        const file = await this.openFile(resolved.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const temporaryPath = join(
            dirname(resolved.path),
            `.${basename(resolved.path)}.${randomUUID()}.caxri-tmp`,
        );
        let openedReplacementStats: Stats | undefined;
        try {
            if ((await realpath(resolved.path)) !== resolved.path)
                throw new CaxriError('IO', 'File path changed during save');
            const openedStats = await file.stat();
            if (
                !openedStats.isFile() ||
                openedStats.dev !== stats.dev ||
                openedStats.ino !== stats.ino ||
                openedStats.nlink > 1
            ) {
                throw new CaxriError(
                    'IO',
                    'File changed during save or has multiple filesystem links',
                );
            }
            if (expectedContentHash !== undefined) {
                const currentHash = createHash('sha256')
                    .update(await file.readFile())
                    .digest('hex');
                if (currentHash !== expectedContentHash)
                    throw new CaxriError('CONFLICT', 'File changed since it was opened');
            }
            const replacement = await this.openFile(
                temporaryPath,
                constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
                stats.mode & 0o777,
            );
            try {
                openedReplacementStats = await replacement.stat();
                const currentReplacementStats = await lstat(temporaryPath);
                const resolvedTemporaryPath = await realpath(temporaryPath);
                /**
                 * `O_NOFOLLOW` covers only the final component. Revalidate the opened temporary inode and its canonical
                 * parent before writing editor content, so a parent directory swapped to an outside symlink cannot
                 * receive the replacement bytes.
                 */
                if (
                    resolvedTemporaryPath !== temporaryPath ||
                    currentReplacementStats.isSymbolicLink() ||
                    !currentReplacementStats.isFile() ||
                    currentReplacementStats.dev !== openedReplacementStats.dev ||
                    currentReplacementStats.ino !== openedReplacementStats.ino ||
                    currentReplacementStats.nlink > 1
                )
                    throw new CaxriError('IO', 'Temporary file changed during save');
                await replacement.writeFile(content, 'utf8');
                /**
                 * The replacement must be durable before rename: otherwise a successful save can still expose an empty
                 * new inode after a sudden power loss. chmod restores bits masked by the process umask without carrying
                 * special setuid/setgid bits forward.
                 */
                await replacement.chmod(stats.mode & 0o777);
                await replacement.sync();
            } finally {
                await replacement.close();
            }
            await this.beforeReplaceValidation?.();
            await this.resolveDocumentPath(sessionId, path, resolved);
            const currentStats = await lstat(resolved.path);
            if (
                currentStats.isSymbolicLink() ||
                !currentStats.isFile() ||
                currentStats.dev !== stats.dev ||
                currentStats.ino !== stats.ino ||
                currentStats.nlink > 1 ||
                (expectedContentHash !== undefined &&
                    (currentStats.mtimeMs !== openedStats.mtimeMs ||
                        currentStats.ctimeMs !== openedStats.ctimeMs ||
                        currentStats.size !== openedStats.size)) ||
                (await realpath(resolved.path)) !== resolved.path
            )
                throw new CaxriError('IO', 'File changed during save');
            /**
             * Node exposes no atomic inode-compare-and-replace primitive. This final revalidation rejects path swaps
             * observed while the replacement is written; an uncooperative external process can still win the narrow
             * check-to-rename race. `rename` replaces a late symlink itself rather than following it, so Caxri never
             * writes through that link.
             */
            await this.replaceFile(temporaryPath, resolved.path);
            const directory = await this.openFile(dirname(resolved.path), constants.O_RDONLY);
            try {
                await directory.sync();
            } finally {
                await directory.close();
            }
        } finally {
            await file.close();
            await removeTrustedTemporaryFile(temporaryPath, openedReplacementStats);
        }
        this.logger.write('info', logEventCatalog.file.saved, {
            fields: {
                sessionId,
                path: relative(resolved.root, resolved.workspacePath ?? resolved.path),
            },
        });
        return this.read(sessionId, resolved.workspacePath ?? resolved.path, undefined, resolved);
    }
}
