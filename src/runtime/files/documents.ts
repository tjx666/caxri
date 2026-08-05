import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { relative } from 'node:path';

import { CaxriError } from '../../shared/ipc';
import type { StructuredLogger } from '../../shared/node/logger';
import type { FileDocument } from '../../shared/types';
import type { ResolvedSessionPath } from '../workspace-paths';

export type ResolveSessionPath = (
    sessionId: string,
    input?: string,
) => Promise<ResolvedSessionPath>;

export type OpenFile = (path: string, flags: number, mode?: number) => ReturnType<typeof open>;

export interface DocumentServiceOptions {
    openFile?: OpenFile;
}

/** Reads and writes text documents under a Session's Project root with TOCTOU-safe file handles. */
export class DocumentService {
    private readonly openFile: OpenFile;

    constructor(
        private readonly resolveSessionPath: ResolveSessionPath,
        private readonly logger: StructuredLogger,
        private readonly maxFileBytes: () => number,
        options: DocumentServiceOptions = {},
    ) {
        this.openFile = options.openFile ?? open;
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
        const file = await this.openFile(resolved.path, constants.O_WRONLY | constants.O_NOFOLLOW);
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
            await file.truncate(0);
            await file.writeFile(content, 'utf8');
        } finally {
            await file.close();
        }
        this.logger.write('info', 'file.saved', {
            fields: { sessionId, path: relative(resolved.root, resolved.path) },
        });
        return this.read(sessionId, resolved.path);
    }
}
