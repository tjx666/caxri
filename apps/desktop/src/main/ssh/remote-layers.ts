import type { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { PassThrough, Readable as ReadableStream } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { createGzip } from 'node:zlib';

import { CaxriError } from '@caxri/protocol';
import { execFileAsync } from '@caxri/system';
import { z } from 'zod';

const MAX_DESCRIPTOR_BYTES = 64 * 1024;
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const relativePathSchema = z
    .string()
    .max(512)
    .regex(/^[\w.-]+(?:\/[\w.-]+)*$/u)
    .refine((value) => !value.split('/').includes('..'), 'Path must stay inside the artifact');

const runtimeSourceSchema = z.object({
    url: z.string().regex(/^https:\/\/[^\s'"]+$/u),
    sha256: sha256Schema,
    member: relativePathSchema,
});

/**
 * `descriptor.json` written by the Server build next to each Linux application layer
 * (`apps/server/dist/remote/linux-<arch>/`, `<resources>/remote/linux-<arch>/` when packaged). The application tarball
 * excludes the Node runtime and source maps and carries a top-level `SHA256SUMS` for every file it contains.
 */
const remoteLayerDescriptorSchema = z.object({
    schemaVersion: z.literal(1),
    target: z.enum(['linux-x64', 'linux-arm64']),
    /**
     * Remote install identity (`builds/<buildId>`).
     */
    buildId: z.string().regex(/^[0-9a-f]{16}$/u),
    /**
     * `computeBuildFingerprint` of the bundles, the same value the Server reports as `buildId` in `host.status`.
     */
    fingerprint: z.string().min(1).max(200),
    version: z.string().min(1).max(100),
    commit: z.string().max(100),
    glibcBaseline: z.string().regex(/^\d+\.\d+$/u),
    app: z.object({
        file: z.string().regex(/^[\w.-]+$/u),
        sha256: sha256Schema,
        bytes: z.number().int().positive(),
    }),
    runtime: z.object({
        sha256: sha256Schema,
        bytes: z.number().int().positive(),
        path: relativePathSchema,
        source: runtimeSourceSchema,
    }),
});

export type RemoteLayerDescriptor = z.infer<typeof remoteLayerDescriptorSchema>;
export type RemoteArchitecture = 'x64' | 'arm64';

export interface RemoteLayer {
    appPath: string;
    descriptor: RemoteLayerDescriptor;
    directory: string;
}

/**
 * Reads and validates the application layer for one Linux architecture. A missing layer means this Desktop build was
 * packaged without remote support for that architecture.
 */
export async function readRemoteLayer(
    root: string,
    architecture: RemoteArchitecture,
): Promise<RemoteLayer> {
    const target = `linux-${architecture}` as const;
    const directory = join(root, target);
    let source: string;
    try {
        const metadata = await lstat(join(directory, 'descriptor.json'));
        if (!metadata.isFile() || metadata.size > MAX_DESCRIPTOR_BYTES)
            throw new CaxriError('VALIDATION', 'Remote Server descriptor is not a bounded file');
        source = await readFile(join(directory, 'descriptor.json'), 'utf8');
    } catch (error) {
        if (error instanceof CaxriError) throw error;
        throw new CaxriError('NOT_FOUND', `This build has no remote Server for ${target}`);
    }
    let descriptor: RemoteLayerDescriptor;
    try {
        descriptor = remoteLayerDescriptorSchema.parse(JSON.parse(source));
    } catch {
        throw new CaxriError('VALIDATION', 'Remote Server descriptor is invalid');
    }
    if (descriptor.target !== target)
        throw new CaxriError('VALIDATION', 'Remote Server descriptor targets another architecture');
    const appPath = join(directory, descriptor.app.file);
    const appMetadata = await lstatOrUndefined(appPath);
    if (!appMetadata?.isFile() || appMetadata.size !== descriptor.app.bytes)
        throw new CaxriError('NOT_FOUND', 'Remote Server application layer is missing');
    return { appPath, descriptor, directory };
}

async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
    try {
        return await lstat(path);
    } catch {
        return undefined;
    }
}

async function sha256File(path: string): Promise<string> {
    const hash = createHash('sha256');
    await pipeline(createReadStream(path), hash);
    return hash.digest('hex');
}

async function isVerifiedFile(path: string, sha256: string): Promise<boolean> {
    try {
        if (!(await lstat(path)).isFile()) return false;
        return (await sha256File(path)) === sha256;
    } catch {
        return false;
    }
}

export interface LocalRuntimeOptions {
    cacheDirectory: string;
    /**
     * Test seam for the download.
     */
    fetchImplementation?: typeof fetch;
    runtime: RemoteLayerDescriptor['runtime'];
}

/**
 * Returns a verified local copy of the remote Node binary, downloading the pinned archive into the cache when needed.
 * Used only when the SSH Host cannot download the runtime itself. Both the archive and the extracted binary are checked
 * against the descriptor's hashes before the binary enters the cache.
 */
export async function ensureLocalRuntime(options: LocalRuntimeOptions): Promise<string> {
    const { runtime } = options;
    const targetDirectory = join(options.cacheDirectory, runtime.sha256);
    const target = join(targetDirectory, 'node');
    if (await isVerifiedFile(target, runtime.sha256)) return target;
    await mkdir(options.cacheDirectory, { recursive: true });
    const temporary = await mkdtemp(join(options.cacheDirectory, '.tmp-'));
    try {
        const archive = join(temporary, 'archive');
        const response = await (options.fetchImplementation ?? fetch)(runtime.source.url);
        if (!response.ok || !response.body)
            throw new CaxriError(
                'UNAVAILABLE',
                `Node runtime download failed (${response.status})`,
            );
        await pipeline(
            ReadableStream.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>),
            createWriteStream(archive),
        );
        if ((await sha256File(archive)) !== runtime.source.sha256)
            throw new CaxriError('VALIDATION', 'Node runtime archive checksum mismatch');
        // `tar -xf` detects gzip and xz compression on both bsdtar (macOS) and GNU tar.
        await execFileAsync('tar', ['-xf', archive, '-C', temporary, '--', runtime.source.member]);
        const extracted = join(temporary, runtime.source.member);
        if ((await sha256File(extracted)) !== runtime.sha256)
            throw new CaxriError('VALIDATION', 'Node runtime binary checksum mismatch');
        await mkdir(targetDirectory, { recursive: true });
        await rename(extracted, target);
        return target;
    } finally {
        await rm(temporary, { force: true, recursive: true });
    }
}

/**
 * Streams a file and reports each chunk's size before it is consumed, so upload progress counts source bytes.
 */
export function progressStream(path: string, onBytes: (bytes: number) => void): Readable {
    const source = createReadStream(path);
    const counter = new PassThrough();
    source.on('data', (chunk: Buffer | string) => onBytes(chunk.length));
    source.on('error', (error) => counter.destroy(error));
    return source.pipe(counter);
}

/**
 * The runtime travels gzip-compressed because the remote `upload-runtime` script decompresses with `gzip -dc`.
 */
export function gzipProgressStream(path: string, onBytes: (bytes: number) => void): Readable {
    const gzip = createGzip();
    const source = progressStream(path, onBytes);
    source.on('error', (error) => gzip.destroy(error));
    return source.pipe(gzip);
}
