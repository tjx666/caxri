import { Buffer } from 'node:buffer';
import { chmod, lstat, mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

import { CaxriError } from '@caxri/protocol';

const MAX_IMAGE_BYTES = 3 * 1_024 * 1_024;
const MAX_PENDING_UPLOADS = 16;
/**
 * Uploads kept for their hour after completing. A Chat message carries up to `MAX_AGENT_CHAT_IMAGES` images, each with
 * its thumbnail, so this holds three full messages' worth plus Terminal attachments.
 */
const MAX_COMPLETED_IMAGES = 128;
const PENDING_LIFETIME_MS = 2 * 60_000;
const IMAGE_LIFETIME_MS = 60 * 60_000;
/**
 * Scoped by uid: on Linux `tmpdir()` is the shared `/tmp`, where a fixed name could be pre-created by another account.
 */
const IMAGE_ROOT = join(tmpdir(), `caxri-mobile-images-${userInfo().uid}`);

interface Upload {
    chunks: Buffer[];
    count: number;
    owner: string;
    sessionId: string;
    size: number;
    path?: string;
    expiresAt: number;
    timer: ReturnType<typeof setTimeout>;
}

/**
 * Keeps incomplete encrypted uploads in bounded memory. Only a complete validated JPEG reaches disk; completed images
 * remain briefly so an Agent can read them after its input is accepted, including when the send receipt is uncertain.
 */
export class MobileImageStore {
    readonly #uploads = new Map<string, Upload>();
    readonly #root: string;

    constructor(root = IMAGE_ROOT) {
        this.#root = root;
    }

    #scheduleExpiry(attachmentId: string, lifetimeMs: number): ReturnType<typeof setTimeout> {
        const timer = setTimeout(() => {
            const current = this.#uploads.get(attachmentId);
            this.#uploads.delete(attachmentId);
            if (current?.path) {
                // eslint-disable-next-line no-void -- A later upload also sweeps files after a failed unlink.
                void unlink(current.path).catch(() => {});
            }
        }, lifetimeMs);
        timer.unref();
        return timer;
    }

    async #cleanExpiredFiles(): Promise<void> {
        await mkdir(this.#root, { recursive: true, mode: 0o700 });
        // A planted symlink or foreign directory would expose uploaded images to another account.
        const metadata = await lstat(this.#root);
        if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== userInfo().uid)
            throw new CaxriError('CONFLICT', 'The mobile image directory is not owned by you.');
        await chmod(this.#root, 0o700);
        const entries = await readdir(this.#root);
        for (const name of entries) {
            if (!/^image_[0-9a-f]{32}\.jpg$/u.test(name)) continue;
            const path = join(this.#root, name);
            try {
                // eslint-disable-next-line no-await-in-loop -- Expired files are swept serially to keep disk work bounded.
                if (Date.now() - (await stat(path)).mtimeMs > IMAGE_LIFETIME_MS)
                    // eslint-disable-next-line no-await-in-loop -- A later sweep retries a failed removal.
                    await unlink(path);
            } catch {
                // A concurrent expiry may already have removed the file.
            }
        }
    }

    async upload(parameters: {
        attachmentId: string;
        chunk: string;
        chunkCount: number;
        chunkIndex: number;
        owner: string;
        sessionId: string;
    }): Promise<{ ready: boolean }> {
        const { attachmentId, chunk, chunkCount, chunkIndex, owner, sessionId } = parameters;
        if (!/^image_[0-9a-f]{32}$/u.test(attachmentId))
            throw new CaxriError('VALIDATION', 'Invalid image attachment ID');
        if (
            !this.#uploads.has(attachmentId) &&
            this.#uploads
                .values()
                .filter((item) => !item.path)
                .toArray().length >= MAX_PENDING_UPLOADS
        )
            throw new CaxriError('CAPACITY', 'Too many pending mobile image uploads');
        const bytes = Buffer.from(chunk, 'base64');
        if (bytes.length === 0 || bytes.toString('base64') !== chunk)
            throw new CaxriError('VALIDATION', 'Invalid image chunk');
        let upload = this.#uploads.get(attachmentId);
        if (!upload) {
            const timer = this.#scheduleExpiry(attachmentId, PENDING_LIFETIME_MS);
            upload = {
                chunks: [],
                count: chunkCount,
                owner,
                sessionId,
                size: 0,
                expiresAt: Date.now() + PENDING_LIFETIME_MS,
                timer,
            };
            this.#uploads.set(attachmentId, upload);
        }
        if (upload.owner !== owner || upload.sessionId !== sessionId || upload.count !== chunkCount)
            throw new CaxriError('CONFLICT', 'Image upload identity changed');
        if (upload.path) return { ready: true };
        if (chunkIndex !== upload.chunks.length)
            throw new CaxriError('CONFLICT', 'Image chunks must arrive in order');
        upload.size += bytes.length;
        if (upload.size > MAX_IMAGE_BYTES) {
            this.#uploads.delete(attachmentId);
            clearTimeout(upload.timer);
            throw new CaxriError('CAPACITY', 'Image exceeds the mobile attachment limit');
        }
        upload.chunks.push(bytes);
        if (upload.chunks.length < upload.count) {
            clearTimeout(upload.timer);
            upload.expiresAt = Date.now() + PENDING_LIFETIME_MS;
            upload.timer = this.#scheduleExpiry(attachmentId, PENDING_LIFETIME_MS);
            return { ready: false };
        }
        const image = Buffer.concat(upload.chunks);
        if (image[0] !== 0xff || image[1] !== 0xd8 || image[2] !== 0xff) {
            this.#uploads.delete(attachmentId);
            clearTimeout(upload.timer);
            throw new CaxriError('VALIDATION', 'Only JPEG images can be attached');
        }
        if (
            this.#uploads
                .values()
                .filter((item) => item.path)
                .toArray().length >= MAX_COMPLETED_IMAGES
        ) {
            this.#uploads.delete(attachmentId);
            clearTimeout(upload.timer);
            throw new CaxriError('CAPACITY', 'Too many retained mobile images');
        }
        await this.#cleanExpiredFiles();
        const path = join(this.#root, `${attachmentId}.jpg`);
        await writeFile(path, image, { flag: 'wx', mode: 0o600 });
        upload.path = path;
        upload.chunks = [];
        clearTimeout(upload.timer);
        upload.expiresAt = Date.now() + IMAGE_LIFETIME_MS;
        upload.timer = this.#scheduleExpiry(attachmentId, IMAGE_LIFETIME_MS);
        return { ready: true };
    }

    /**
     * The uploaded JPEGs as base64, for a Chat message whose provider takes image data rather than a file path.
     */
    async read(
        owner: string,
        sessionId: string,
        attachmentIds: readonly string[],
    ): Promise<string[]> {
        const paths = this.paths(owner, sessionId, attachmentIds);
        return Promise.all(paths.map(async (path) => (await readFile(path)).toString('base64')));
    }

    paths(owner: string, sessionId: string, attachmentIds: readonly string[]): string[] {
        return attachmentIds.map((id) => {
            const upload = this.#uploads.get(id);
            if (
                !upload?.path ||
                upload.owner !== owner ||
                upload.sessionId !== sessionId ||
                upload.expiresAt <= Date.now()
            )
                throw new CaxriError('NOT_FOUND', 'Image attachment is unavailable');
            return upload.path;
        });
    }
}
