import type { BigIntStats } from 'node:fs';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { CaxriError } from '@caxri/protocol';

export interface FileIdentity {
    device: string;
    inode: string;
    path: string;
}

export interface CopyLimits {
    maximumBytes: number;
    maximumDurationMs: number;
    maximumEntries: number;
}

interface CopyBudget {
    bytes: number;
    entries: number;
    startedAt: number;
}

export interface CopyEntry extends FileIdentity {
    kind: 'directory' | 'file';
    mode: number;
    relativePath: string;
}

export interface CopyManifest {
    entries: CopyEntry[];
    totalBytes: number;
}

export interface CopyFileOptions {
    signal: AbortSignal;
}

export type CopyFile = (
    source: FileHandle,
    target: FileHandle,
    options: CopyFileOptions,
) => Promise<void>;

export const MAX_CONCURRENT_COPY_VALIDATIONS = 32;
export const DEFAULT_COPY_LIMITS: CopyLimits = {
    maximumBytes: 20 * 1024 * 1024 * 1024,
    maximumDurationMs: 5 * 60_000,
    maximumEntries: 100_000,
};

export async function streamCopyFile(
    source: FileHandle,
    target: FileHandle,
    options: CopyFileOptions,
): Promise<void> {
    await pipeline(source.createReadStream(), target.createWriteStream(), {
        signal: options.signal,
    });
}

export async function createdIdentity(path: string): Promise<FileIdentity> {
    const stats = await lstat(path, { bigint: true });
    return { path, device: stats.dev.toString(), inode: stats.ino.toString() };
}

export async function createdHandleIdentity(file: FileHandle, path: string): Promise<FileIdentity> {
    const stats = await file.stat({ bigint: true });
    return { path, device: stats.dev.toString(), inode: stats.ino.toString() };
}

export async function assertPathIdentity(identity: FileIdentity): Promise<void> {
    const stats = await lstat(identity.path, { bigint: true });
    if (
        stats.isSymbolicLink() ||
        stats.dev.toString() !== identity.device ||
        stats.ino.toString() !== identity.inode
    )
        throw new CaxriError('CONFLICT', 'Copy destination changed during the operation');
}

async function assertCopyEntryIdentity(entry: CopyEntry): Promise<void> {
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

async function assertOpenFileIdentity(file: FileHandle, entry: CopyEntry): Promise<void> {
    const stats = await file.stat({ bigint: true });
    if (
        !stats.isFile() ||
        stats.dev.toString() !== entry.device ||
        stats.ino.toString() !== entry.inode ||
        stats.nlink > 1n
    )
        throw new CaxriError('CONFLICT', 'File changed while it was being copied');
}

async function chmodCreatedDirectory(identity: FileIdentity, mode: number): Promise<void> {
    await assertPathIdentity(identity);
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

/**
 * Walks and transfers a recursive copy source tree under the same identity-revalidation discipline as the rest of
 * `FileMutationService`, isolated here because the tree inspection and transfer phases are a large, self-contained unit
 * of logic.
 */
export class CopyTreeExecutor {
    constructor(
        private readonly now: () => number,
        private readonly copyLimits: CopyLimits,
        private readonly copyFile: CopyFile,
    ) {}

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

    assertCopyDeadline(startedAt: number, signal: AbortSignal): void {
        if (signal.aborted || this.now() - startedAt > this.copyLimits.maximumDurationMs)
            throw new CaxriError('TIMEOUT', 'Copy exceeded the file operation time limit');
    }

    async inspectCopyTree(
        source: string,
        startedAt: number,
        signal: AbortSignal,
    ): Promise<CopyManifest> {
        const budget: CopyBudget = { bytes: 0, entries: 0, startedAt };
        const pending = [source];
        const entries: CopyEntry[] = [];
        /**
         * `budget` (entry count and byte total) is a shared accumulator that `inspectCopyEntry` checks and updates on
         * every iteration to bail out as soon as a safety limit is crossed; parallelizing the tree walk would let an
         * oversized tree keep expanding concurrently past the limit before any single check could observe it.
         */
        while (pending.length > 0) {
            const candidate = pending.pop();
            if (!candidate) break;
            this.assertCopyDeadline(startedAt, signal);
            // eslint-disable-next-line no-await-in-loop -- see comment above the loop
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
            // eslint-disable-next-line no-await-in-loop -- see comment above the loop
            const names = await readdir(candidate);
            for (const name of names) pending.push(resolve(candidate, name));
        }
        return { entries, totalBytes: budget.bytes };
    }

    async copyEntries(
        entries: readonly CopyEntry[],
        targetRoot: string,
        startedAt: number,
        signal: AbortSignal,
        assertDestinationIdentity: () => Promise<void>,
        onTargetCreated: (target: FileIdentity) => void,
    ): Promise<void> {
        const targetDirectories = new Map<string, FileIdentity>();
        /**
         * `entries` is ordered parent-before-descendant (by construction in `inspectCopyTree`), and this loop relies on
         * that order plus the incrementally built `targetDirectories` map to create each parent directory before
         * copying into it; parallelizing iterations would try to copy into directories that do not exist yet.
         */
        for (const entry of entries) {
            this.assertCopyDeadline(startedAt, signal);
            // eslint-disable-next-line no-await-in-loop -- see comment above the loop
            await Promise.all([assertCopyEntryIdentity(entry), assertDestinationIdentity()]);
            const targetPath = entry.relativePath
                ? resolve(targetRoot, entry.relativePath)
                : targetRoot;
            const parentIdentity = targetDirectories.get(dirname(targetPath));
            // eslint-disable-next-line no-await-in-loop -- see comment above the loop
            if (parentIdentity) await assertPathIdentity(parentIdentity);

            if (entry.kind === 'directory') {
                // eslint-disable-next-line no-await-in-loop -- see comment above the loop
                await mkdir(targetPath, { mode: (entry.mode & 0o777) | 0o700 });
                // eslint-disable-next-line no-await-in-loop -- see comment above the loop
                const identity = await createdIdentity(targetPath);
                targetDirectories.set(targetPath, identity);
                onTargetCreated(identity);
                this.assertCopyDeadline(startedAt, signal);
                continue;
            }

            // eslint-disable-next-line no-await-in-loop -- see comment above the loop
            const source = await open(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW);
            let target: FileHandle | undefined;
            try {
                // eslint-disable-next-line no-await-in-loop -- see comment above the loop
                await assertOpenFileIdentity(source, entry);
                // eslint-disable-next-line no-await-in-loop -- see comment above the loop
                target = await open(
                    targetPath,
                    constants.O_WRONLY |
                        constants.O_CREAT |
                        constants.O_EXCL |
                        constants.O_NOFOLLOW,
                    entry.mode,
                );
                // eslint-disable-next-line no-await-in-loop -- see comment above the loop
                const identity = await createdHandleIdentity(target, targetPath);
                onTargetCreated(identity);
                // eslint-disable-next-line no-await-in-loop -- see comment above the loop
                await target.chmod(entry.mode & 0o777);
                // eslint-disable-next-line no-await-in-loop -- see comment above the loop
                await this.copyFile(source, target, { signal });
                this.assertCopyDeadline(startedAt, signal);
            } finally {
                // eslint-disable-next-line no-await-in-loop -- see comment above the loop
                await Promise.allSettled([source.close(), target?.close()]);
            }
        }
        /**
         * Descendants must retain traversal permission until their modes are restored, so this loop walks `entries`
         * bottom-up (reverse of parent-before-descendant order) and must stay sequential to avoid narrowing a parent's
         * permissions while a descendant is still being chmod'd through it.
         */
        for (const entry of entries.toReversed()) {
            this.assertCopyDeadline(startedAt, signal);
            if (entry.kind !== 'directory') continue;
            const targetPath = entry.relativePath
                ? resolve(targetRoot, entry.relativePath)
                : targetRoot;
            const identity = targetDirectories.get(targetPath);
            // oxlint-disable-next-line react-doctor/async-await-in-loop
            // eslint-disable-next-line no-await-in-loop -- see comment above the loop
            if (identity) await chmodCreatedDirectory(identity, entry.mode & 0o777);
        }
        this.assertCopyDeadline(startedAt, signal);
    }
}
