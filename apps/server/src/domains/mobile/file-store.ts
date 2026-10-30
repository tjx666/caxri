import { Buffer } from 'node:buffer';
import type { FileHandle } from 'node:fs/promises';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

import {
    CaxriError,
    isMobileFileName,
    MAX_MOBILE_FILE_BYTES,
    MOBILE_FILE_CHUNK_BYTES,
    mobileFileChunkCount,
} from '@caxri/protocol';

import { ensurePrivateUploadDirectory } from './private-upload-directory';

const ATTACHMENT_ID = /^file_[0-9a-f]{32}$/u;
const ENTRY_NAME = /^(?<id>file_[0-9a-f]{32})(?:\.part)?$/u;
const MAX_PENDING_UPLOADS = 8;
const MAX_COMPLETED_FILES = 64;
/**
 * Bytes the store holds on disk at once, pending and completed together, so a phone cannot fill the disk with large
 * files it never sends.
 */
const MAX_RETAINED_BYTES = 2 * 1_024 * 1_024 * 1_024;
const PENDING_LIFETIME_MS = 2 * 60_000;
const FILE_LIFETIME_MS = 60 * 60_000;
/**
 * Scoped by uid: on Linux `tmpdir()` is the shared `/tmp`, where a fixed name could be pre-created by another account.
 */
const FILE_ROOT = join(tmpdir(), `caxri-mobile-files-${userInfo().uid}`);

interface Upload {
    owner: string;
    sessionId: string;
    name: string;
    size: number;
    count: number;
    received: Set<number>;
    /**
     * Open while chunks arrive; each chunk is written at its own offset, so chunks may arrive in any order.
     */
    handle?: Promise<FileHandle>;
    /**
     * Set once the last chunk landed and the file moved under its own name.
     */
    path?: string;
    completing?: Promise<void>;
    expiresAt: number;
    timer?: ReturnType<typeof setTimeout>;
}

/**
 * Files of any type a phone uploads for an Agent to read. Unlike `MobileImageStore`, chunks go straight to disk because
 * a phone video runs to many megabytes. A completed file sits at `<root>/<attachmentId>/<name>`, so the Agent sees the
 * name the user picked, and stays for an hour for a message to cite it, including when the send receipt is uncertain.
 */
export class MobileFileStore {
    readonly #uploads = new Map<string, Upload>();
    readonly #root: string;

    constructor(root = FILE_ROOT) {
        this.#root = root;
    }

    #partPath(attachmentId: string): string {
        return join(this.#root, `${attachmentId}.part`);
    }

    #discard(attachmentId: string): void {
        const upload = this.#uploads.get(attachmentId);
        if (!upload) return;
        this.#uploads.delete(attachmentId);
        clearTimeout(upload.timer);
        void (async () => {
            // Each step is best effort: the expired-entry sweep removes whatever a failure leaves.
            try {
                await (await upload.handle)?.close();
            } catch {
                // The handle never opened or is already closed.
            }
            try {
                await rm(this.#partPath(attachmentId), { force: true });
                await rm(join(this.#root, attachmentId), { recursive: true, force: true });
            } catch {
                // A later sweep retries.
            }
        })();
    }

    #extend(attachmentId: string, upload: Upload, lifetimeMs: number): void {
        clearTimeout(upload.timer);
        upload.expiresAt = Date.now() + lifetimeMs;
        upload.timer = setTimeout(() => this.#discard(attachmentId), lifetimeMs);
        upload.timer.unref();
    }

    /**
     * Removes entries an earlier Server left behind past their lifetime; a pending one this Server still tracks stays.
     */
    async #cleanExpiredEntries(): Promise<void> {
        await ensurePrivateUploadDirectory(this.#root);
        const names = await readdir(this.#root);
        for (const name of names) {
            const id = ENTRY_NAME.exec(name)?.groups?.id;
            if (!id || this.#uploads.has(id)) continue;
            const path = join(this.#root, name);
            try {
                // eslint-disable-next-line no-await-in-loop -- Expired entries are swept serially to keep disk work bounded.
                if (Date.now() - (await stat(path)).mtimeMs > FILE_LIFETIME_MS)
                    // eslint-disable-next-line no-await-in-loop -- A later sweep retries a failed removal.
                    await rm(path, { recursive: true, force: true });
            } catch {
                // A concurrent expiry may already have removed the entry.
            }
        }
    }

    #retainedBytes(): number {
        return this.#uploads.values().reduce((total, upload) => total + upload.size, 0);
    }

    #start(parameters: {
        attachmentId: string;
        name: string;
        owner: string;
        sessionId: string;
        size: number;
    }): Upload {
        const { attachmentId, name, owner, sessionId, size } = parameters;
        const uploads = this.#uploads.values().toArray();
        if (uploads.filter((item) => !item.path).length >= MAX_PENDING_UPLOADS)
            throw new CaxriError('CAPACITY', 'Too many pending mobile file uploads');
        if (uploads.filter((item) => item.path).length >= MAX_COMPLETED_FILES)
            throw new CaxriError('CAPACITY', 'Too many retained mobile files');
        if (this.#retainedBytes() + size > MAX_RETAINED_BYTES)
            throw new CaxriError('CAPACITY', 'Mobile file uploads use too much disk space');
        const upload: Upload = {
            owner,
            sessionId,
            name,
            size,
            count: mobileFileChunkCount(size),
            received: new Set(),
            expiresAt: 0,
        };
        this.#uploads.set(attachmentId, upload);
        this.#extend(attachmentId, upload, PENDING_LIFETIME_MS);
        upload.handle = (async () => {
            await this.#cleanExpiredEntries();
            return open(this.#partPath(attachmentId), 'wx', 0o600);
        })();
        return upload;
    }

    async #complete(attachmentId: string, upload: Upload): Promise<void> {
        await (await upload.handle!).close();
        upload.handle = undefined;
        const directory = join(this.#root, attachmentId);
        await mkdir(directory, { mode: 0o700 });
        const path = join(directory, upload.name);
        await rename(this.#partPath(attachmentId), path);
        upload.path = path;
        upload.received.clear();
        this.#extend(attachmentId, upload, FILE_LIFETIME_MS);
    }

    async upload(parameters: {
        attachmentId: string;
        chunk: string;
        chunkIndex: number;
        name: string;
        owner: string;
        sessionId: string;
        size: number;
    }): Promise<{ ready: boolean; path?: string }> {
        const { attachmentId, chunk, chunkIndex, name, owner, sessionId, size } = parameters;
        if (!ATTACHMENT_ID.test(attachmentId))
            throw new CaxriError('VALIDATION', 'Invalid file attachment ID');
        if (!isMobileFileName(name)) throw new CaxriError('VALIDATION', 'Invalid file name');
        if (!Number.isSafeInteger(size) || size < 0 || size > MAX_MOBILE_FILE_BYTES)
            throw new CaxriError('CAPACITY', 'File exceeds the mobile attachment limit');
        const count = mobileFileChunkCount(size);
        if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= count)
            throw new CaxriError('VALIDATION', 'File chunk is out of range');
        const bytes = Buffer.from(chunk, 'base64');
        const expected =
            chunkIndex < count - 1
                ? MOBILE_FILE_CHUNK_BYTES
                : size - (count - 1) * MOBILE_FILE_CHUNK_BYTES;
        if (bytes.length !== expected || bytes.toString('base64') !== chunk)
            throw new CaxriError('VALIDATION', 'Invalid file chunk');
        const upload =
            this.#uploads.get(attachmentId) ??
            this.#start({ attachmentId, name, owner, sessionId, size });
        if (
            upload.owner !== owner ||
            upload.sessionId !== sessionId ||
            upload.name !== name ||
            upload.size !== size
        )
            throw new CaxriError('CONFLICT', 'File upload identity changed');
        if (upload.path) return { ready: true, path: upload.path };
        // A chunk resent after an uncertain reply is already on disk.
        if (upload.received.has(chunkIndex)) {
            await upload.completing;
            return upload.path ? { ready: true, path: upload.path } : { ready: false };
        }
        try {
            const handle = await upload.handle!;
            await handle.write(bytes, 0, bytes.length, chunkIndex * MOBILE_FILE_CHUNK_BYTES);
        } catch (error) {
            this.#discard(attachmentId);
            throw error;
        }
        upload.received.add(chunkIndex);
        if (upload.received.size < upload.count) {
            this.#extend(attachmentId, upload, PENDING_LIFETIME_MS);
            return { ready: false };
        }
        upload.completing ??= (async () => {
            try {
                await this.#complete(attachmentId, upload);
            } catch (error) {
                this.#discard(attachmentId);
                throw error;
            }
        })();
        await upload.completing;
        return { ready: true, path: upload.path! };
    }

    /**
     * Where each named upload sits on disk, for a message to cite. Only the device generation that uploaded a file may
     * cite it, and only in the Session it was uploaded to.
     */
    paths(owner: string, sessionId: string, attachmentIds: readonly string[]): string[] {
        return attachmentIds.map((id) => {
            const upload = this.#uploads.get(id);
            if (
                !upload?.path ||
                upload.owner !== owner ||
                upload.sessionId !== sessionId ||
                upload.expiresAt <= Date.now()
            )
                throw new CaxriError('NOT_FOUND', 'File attachment is unavailable');
            return upload.path;
        });
    }
}
