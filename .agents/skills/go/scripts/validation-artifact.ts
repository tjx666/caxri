import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

import type { ValidationRecord } from './validation-gate';
import { refreshValidationResult } from './validation-gate';

export interface ValidationLogReceipt {
    byteLength: number;
    metadata: ValidationLogMetadata;
    sha256: string;
}

export interface ValidationLogMetadata {
    ctimeMs: number;
    device: number;
    inode: number;
    mtimeMs: number;
}

interface DirectFileIdentity {
    dev: number;
    ino: number;
}

function errorCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
    return typeof error.code === 'string' ? error.code : undefined;
}

function assertOwned(uid: number): void {
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (currentUid !== null && uid !== currentUid) {
        throw new Error('Validation log must be owned by this user');
    }
}

function hasSameIdentity(left: DirectFileIdentity, right: DirectFileIdentity): boolean {
    return left.dev === right.dev && left.ino === right.ino;
}

function validationLogMetadata(metadata: {
    ctimeMs: number;
    dev: number;
    ino: number;
    mtimeMs: number;
}): ValidationLogMetadata {
    return {
        ctimeMs: metadata.ctimeMs,
        device: metadata.dev,
        inode: metadata.ino,
        mtimeMs: metadata.mtimeMs,
    };
}

function hasSameMetadata(left: ValidationLogMetadata, right: ValidationLogMetadata): boolean {
    return (
        left.ctimeMs === right.ctimeMs &&
        left.device === right.device &&
        left.inode === right.inode &&
        left.mtimeMs === right.mtimeMs
    );
}

async function resolveValidationLogPath(runDirectory: string, logPath: string): Promise<string> {
    const absoluteRunDirectory = resolve(runDirectory);
    const absolutePath = resolve(absoluteRunDirectory, logPath);
    const relativePath = relative(absoluteRunDirectory, absolutePath);
    if (
        relativePath === '' ||
        relativePath === '..' ||
        isAbsolute(relativePath) ||
        relativePath.startsWith(`..${sep}`) ||
        !logPath.startsWith('validation/')
    ) {
        throw new Error('Managed validation logs must stay under validation/');
    }
    const parent = dirname(absolutePath);
    const metadata = await lstat(parent);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error('Validation log parent must be a direct directory');
    }
    assertOwned(metadata.uid);
    const [canonicalRunDirectory, canonicalParent] = await Promise.all([
        realpath(absoluteRunDirectory),
        realpath(parent),
    ]);
    if (canonicalParent !== join(canonicalRunDirectory, dirname(logPath))) {
        throw new Error('Validation log parent left the run directory');
    }
    return absolutePath;
}

export class ValidationLogWriter {
    readonly #handle: FileHandle;
    readonly #hash = createHash('sha256');
    #byteLength = 0;
    #closed = false;
    #writeChain = Promise.resolve();

    constructor(handle: FileHandle) {
        this.#handle = handle;
    }

    write(chunk: Uint8Array | string): void {
        if (this.#closed) throw new Error('Validation log is already closed');
        const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
        // eslint-disable-next-line unicorn/prefer-await -- the promise chain serializes interleaved stdout/stderr writes
        this.#writeChain = this.#writeChain.then(async () => {
            await this.#handle.write(buffer);
            this.#hash.update(buffer);
            this.#byteLength += buffer.byteLength;
        });
    }

    async finish(): Promise<ValidationLogReceipt> {
        if (this.#closed) throw new Error('Validation log is already closed');
        this.#closed = true;
        try {
            await this.#writeChain;
            await this.#handle.sync();
            const metadata = await this.#handle.stat();
            if (metadata.size !== this.#byteLength) {
                throw new Error('Validation log byte count changed before close');
            }
            return {
                byteLength: this.#byteLength,
                metadata: validationLogMetadata(metadata),
                sha256: this.#hash.digest('hex'),
            };
        } finally {
            await this.#handle.close();
        }
    }
}

/**
 * Creates a private, exclusive log file without following links from the recorded run directory.
 */
export async function createValidationLog(
    runDirectory: string,
    logPath: string,
): Promise<ValidationLogWriter> {
    const absolutePath = await resolveValidationLogPath(runDirectory, logPath);
    const handle = await open(
        absolutePath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
    );
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
        await handle.close();
        throw new Error('Validation log must be a regular file');
    }
    assertOwned(metadata.uid);
    return new ValidationLogWriter(handle);
}

export async function inspectValidationLog(
    runDirectory: string,
    logPath: string,
): Promise<ValidationLogReceipt> {
    const absolutePath = await resolveValidationLogPath(runDirectory, logPath);
    const before = await lstat(absolutePath);
    if (before.isSymbolicLink() || !before.isFile()) {
        throw new Error('Validation log must be a direct regular file');
    }
    assertOwned(before.uid);
    const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const opened = await handle.stat();
        if (!hasSameIdentity(opened, before)) {
            throw new Error('Validation log changed before it could be read');
        }
        const hash = createHash('sha256');
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let byteLength = 0;
        for (;;) {
            // eslint-disable-next-line no-await-in-loop -- the same no-follow file handle owns the sequential digest
            const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
            if (bytesRead === 0) break;
            hash.update(buffer.subarray(0, bytesRead));
            byteLength += bytesRead;
        }
        const after = await lstat(absolutePath);
        if (!hasSameIdentity(opened, after) || after.size !== byteLength) {
            throw new Error('Validation log changed while it was being read');
        }
        return {
            byteLength,
            metadata: validationLogMetadata(after),
            sha256: hash.digest('hex'),
        };
    } finally {
        await handle.close();
    }
}

async function inspectValidationLogMetadata(
    runDirectory: string,
    logPath: string,
): Promise<{ byteLength: number; metadata: ValidationLogMetadata }> {
    const absolutePath = await resolveValidationLogPath(runDirectory, logPath);
    const before = await lstat(absolutePath);
    if (before.isSymbolicLink() || !before.isFile()) {
        throw new Error('Validation log must be a direct regular file');
    }
    assertOwned(before.uid);
    const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const opened = await handle.stat();
        if (!hasSameIdentity(opened, before)) {
            throw new Error('Validation log changed before it could be inspected');
        }
        const after = await lstat(absolutePath);
        if (!hasSameIdentity(opened, after)) {
            throw new Error('Validation log changed while it was being inspected');
        }
        return { byteLength: after.size, metadata: validationLogMetadata(after) };
    } finally {
        await handle.close();
    }
}

function artifactError(error: unknown): string {
    if (errorCode(error) === 'ENOENT') return 'Validation log is missing';
    return error instanceof Error ? error.message : 'Validation log could not be verified';
}

/**
 * Ordinary reads compare immutable direct-file metadata in constant time. Explicit ledger validation also recomputes
 * SHA-256, and any metadata drift triggers a digest read before the receipt is rejected.
 */
export async function reconcileValidationArtifacts(
    state: { validations: ValidationRecord[] },
    runDirectory: string,
    verification: 'full' | 'metadata' = 'metadata',
): Promise<void> {
    for (const record of state.validations) {
        if (record.artifactVersion !== 1 || record.result === 'pending') continue;
        let integrityError: string | null = null;
        try {
            if (
                record.logByteLength === null ||
                record.logMetadata === null ||
                record.logSha256 === null
            ) {
                integrityError = 'Validation log receipt is incomplete';
            } else {
                // eslint-disable-next-line no-await-in-loop -- each receipt is independently bound to one direct file
                const metadata = await inspectValidationLogMetadata(runDirectory, record.logPath);
                const isMetadataChanged = !hasSameMetadata(metadata.metadata, record.logMetadata);
                if (metadata.byteLength !== record.logByteLength) {
                    integrityError = `Validation log byte length changed from ${record.logByteLength} to ${metadata.byteLength}`;
                } else if (verification === 'full' || isMetadataChanged) {
                    // eslint-disable-next-line no-await-in-loop -- full validation is explicit; drift is exceptional
                    const actual = await inspectValidationLog(runDirectory, record.logPath);
                    if (actual.sha256 !== record.logSha256) {
                        integrityError =
                            'Validation log SHA-256 does not match the recorded receipt';
                    } else if (isMetadataChanged) {
                        integrityError =
                            'Validation log identity or timestamps changed after the receipt was recorded';
                    }
                }
            }
        } catch (error: unknown) {
            integrityError = artifactError(error);
        }
        if (record.logIntegrityError !== integrityError) {
            record.logIntegrityError = integrityError;
        }
        refreshValidationResult(record);
    }
}
