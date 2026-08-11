import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

import { CaxriError } from '../../shared/ipc/errors';
import type { StructuredLogger } from '../../shared/node/logger';
import type { FileDocument } from '../../shared/types';
import type { ResolvedSessionPath } from '../project-roots';

export type ResolveSessionPath = (
    sessionId: string,
    input?: string,
) => Promise<ResolvedSessionPath>;

export type OpenFile = (path: string, flags: number, mode?: number) => ReturnType<typeof open>;
export type ReplaceFile = typeof rename;

export interface DocumentServiceOptions {
    /** Integration-test seam for replacing the target after the new bytes are durable. */
    beforeReplaceValidation?: () => Promise<void>;
    openFile?: OpenFile;
    replaceFile?: ReplaceFile;
}

/** Reads and writes text documents under a Session's Project root with TOCTOU-safe file handles. */
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

    async read(sessionId: string, path: string): Promise<FileDocument> {
        const resolved = await this.resolveSessionPath(sessionId, path);
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
            ) {
                throw new CaxriError(
                    'IO',
                    'File changed during read or has multiple filesystem links',
                );
            }
            if (openedStats.size > this.maxFileBytes())
                throw new CaxriError(
                    'CAPACITY',
                    `File exceeds the ${this.maxFileBytes()} byte safety limit`,
                );
            const buffer = await file.readFile();
            if (buffer.subarray(0, 8_192).includes(0))
                throw new CaxriError('IO', 'Binary files cannot be opened in the editor');
            return {
                path: resolved.path,
                content: buffer.toString('utf8'),
                mtimeMs: openedStats.mtimeMs,
                size: openedStats.size,
            };
        } finally {
            await file.close();
        }
    }

    async write(sessionId: string, path: string, content: string): Promise<FileDocument> {
        const resolved = await this.resolveSessionPath(sessionId, path);
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
            const replacement = await this.openFile(
                temporaryPath,
                constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
                stats.mode & 0o777,
            );
            try {
                const openedReplacementStats = await replacement.stat();
                const currentReplacementStats = await lstat(temporaryPath);
                const resolvedTemporaryPath = await realpath(temporaryPath);
                const temporaryRelativePath = relative(resolved.root, resolvedTemporaryPath);
                /**
                 * `O_NOFOLLOW` covers only the final component. Revalidate the opened temporary
                 * inode and its canonical parent before writing editor content, so a parent
                 * directory swapped to an outside symlink cannot receive the replacement bytes.
                 */
                if (
                    currentReplacementStats.isSymbolicLink() ||
                    !currentReplacementStats.isFile() ||
                    currentReplacementStats.dev !== openedReplacementStats.dev ||
                    currentReplacementStats.ino !== openedReplacementStats.ino ||
                    currentReplacementStats.nlink > 1 ||
                    isAbsolute(temporaryRelativePath) ||
                    temporaryRelativePath === '..' ||
                    temporaryRelativePath.startsWith(`..${sep}`)
                )
                    throw new CaxriError('IO', 'Temporary file changed during save');
                await replacement.writeFile(content, 'utf8');
                /**
                 * The replacement must be durable before rename: otherwise a successful save can
                 * still expose an empty new inode after a sudden power loss. chmod restores bits
                 * masked by the process umask without carrying special setuid/setgid bits forward.
                 */
                await replacement.chmod(stats.mode & 0o777);
                await replacement.sync();
            } finally {
                await replacement.close();
            }
            await this.beforeReplaceValidation?.();
            const currentStats = await lstat(resolved.path);
            if (
                currentStats.isSymbolicLink() ||
                !currentStats.isFile() ||
                currentStats.dev !== stats.dev ||
                currentStats.ino !== stats.ino ||
                currentStats.nlink > 1 ||
                (await realpath(resolved.path)) !== resolved.path
            )
                throw new CaxriError('IO', 'File changed during save');
            /**
             * Node exposes no atomic inode-compare-and-replace primitive. This final revalidation
             * rejects path swaps observed while the replacement is written; an uncooperative
             * external process can still win the narrow check-to-rename race. `rename` replaces a
             * late symlink itself rather than following it, so Caxri never writes through that link.
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
            await rm(temporaryPath, { force: true });
        }
        this.logger.write('info', 'file.saved', {
            fields: { sessionId, path: relative(resolved.root, resolved.path) },
        });
        return this.read(sessionId, resolved.path);
    }
}
