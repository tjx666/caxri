import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, readdir, rename, rm } from 'node:fs/promises';
import { join, sep } from 'node:path';
import process from 'node:process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { constants as zlibConstants, createGzip } from 'node:zlib';

import type { LinuxArchitecture } from './linux-target';

/**
 * Path of the Node runtime inside the artifact. The application layer never carries it: an SSH Host caches the runtime
 * by content hash and fetches or receives it separately (ADR 0014).
 */
export const REMOTE_RUNTIME_PATH = 'runtime/bin/node';
/**
 * Checksum list at the root of every application layer, in `sha256sum -c` format.
 */
export const REMOTE_CHECKSUMS_FILE = 'SHA256SUMS';
export const APP_LAYER_FILE = 'app.tar.gz';
const TAR_BLOCK = 512;
/**
 * Every tar entry carries this mtime so the same artifact always yields the same bytes.
 */
const FIXED_MTIME = 0;

/**
 * The per-target contract Desktop reads to install a remote Server. Keep the field set stable: Main validates it.
 */
export interface RemoteLayerDescriptor {
    schemaVersion: 1;
    target: `linux-${LinuxArchitecture}`;
    /**
     * First 16 hex digits of the artifact's aggregate SHA-256; names `~/.caxri-server/builds/<buildId>/`.
     */
    buildId: string;
    /**
     * `computeBuildFingerprint` of the bundles; equal to the local Server's, so staleness checks agree.
     */
    fingerprint: string;
    version: string;
    commit: string;
    glibcBaseline: string;
    app: { file: string; sha256: string; bytes: number };
    runtime: {
        sha256: string;
        bytes: number;
        path: string;
        source: { url: string; sha256: string; member: string };
    };
}

interface LayerEntry {
    /**
     * POSIX path relative to the layer root; directories have no trailing slash.
     */
    path: string;
    type: 'directory' | 'file';
    /**
     * Normalized permission bits: 0o755 for directories and executables, 0o644 otherwise.
     */
    mode: number;
    /**
     * Absolute source path for files read from disk; absent for generated content.
     */
    source?: string;
    contents?: Buffer;
    size: number;
}

function compareCodeUnits(left: string, right: string): number {
    if (left === right) return 0;
    return left < right ? -1 : 1;
}

async function sha256File(path: string): Promise<string> {
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
    return digest.digest('hex');
}

/**
 * Lists every directory and regular file under `root` except the excluded paths, with normalized modes. Symbolic links
 * and special files are refused because an SSH Host extracts this layer with plain `tar`.
 */
async function collectLayerEntries(
    root: string,
    exclude: ReadonlySet<string>,
): Promise<LayerEntry[]> {
    const entries: LayerEntry[] = [];
    async function walk(directory: string): Promise<void> {
        const names = (await readdir(directory)).toSorted(compareCodeUnits);
        for (const name of names) {
            const source = join(directory, name);
            const path = source
                .slice(root.length + 1)
                .split(sep)
                .join('/');
            if (exclude.has(path)) continue;
            // eslint-disable-next-line no-await-in-loop -- sequential walk keeps entry order deterministic
            const metadata = await lstat(source);
            if (metadata.isDirectory()) {
                entries.push({ path, type: 'directory', mode: 0o755, size: 0 });
                // eslint-disable-next-line no-await-in-loop -- sequential walk keeps entry order deterministic
                await walk(source);
            } else if (metadata.isFile()) {
                entries.push({
                    path,
                    type: 'file',
                    mode: metadata.mode & 0o111 ? 0o755 : 0o644,
                    source,
                    size: metadata.size,
                });
            } else {
                throw new Error(`Remote layer cannot contain ${path}: not a regular file`);
            }
        }
    }
    await walk(root);
    return entries;
}

/**
 * Renders a `sha256sum -c` checksum list (two spaces, relative paths, sorted) for every file entry.
 */
async function checksumList(entries: readonly LayerEntry[]): Promise<string> {
    const files = entries.filter((entry) => entry.type === 'file');
    const lines = await Promise.all(
        files.map(async (entry) => {
            if (/[\n\\]/u.test(entry.path))
                throw new Error(`Remote layer path cannot be checksummed: ${entry.path}`);
            const digest = entry.contents
                ? createHash('sha256').update(entry.contents).digest('hex')
                : await sha256File(entry.source!);
            return `${digest}  ${entry.path}`;
        }),
    );
    return `${lines.toSorted((left, right) => compareCodeUnits(left.slice(66), right.slice(66))).join('\n')}\n`;
}

function writeOctal(header: Buffer, value: number, offset: number, length: number): void {
    const digits = value.toString(8).padStart(length - 1, '0');
    if (digits.length > length - 1) throw new Error(`Tar field overflow: ${value}`);
    header.write(`${digits}\0`, offset, length, 'ascii');
}

/**
 * Splits a path into the ustar `prefix` (155 bytes) and `name` (100 bytes) fields at a `/` boundary.
 */
function splitUstarPath(path: string): { name: string; prefix: string } {
    if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' };
    for (let index = path.indexOf('/'); index !== -1; index = path.indexOf('/', index + 1)) {
        const prefix = path.slice(0, index);
        const name = path.slice(index + 1);
        if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100)
            return { name, prefix };
    }
    throw new Error(`Path is too long for a ustar archive: ${path}`);
}

/**
 * One ustar header with uid/gid 0, empty owner names, and a fixed mtime: nothing about the build machine leaks into the
 * archive, and no extended (pax or AppleDouble) records are ever written.
 */
function ustarHeader(entry: Pick<LayerEntry, 'mode' | 'path' | 'size' | 'type'>): Buffer {
    const header = Buffer.alloc(TAR_BLOCK);
    const { name, prefix } = splitUstarPath(
        entry.type === 'directory' ? `${entry.path}/` : entry.path,
    );
    header.write(name, 0, 100, 'utf8');
    writeOctal(header, entry.mode, 100, 8);
    writeOctal(header, 0, 108, 8);
    writeOctal(header, 0, 116, 8);
    writeOctal(header, entry.type === 'file' ? entry.size : 0, 124, 12);
    writeOctal(header, FIXED_MTIME, 136, 12);
    header.fill(' ', 148, 156);
    header.write(entry.type === 'file' ? '0' : '5', 156, 1, 'ascii');
    header.write('ustar\u{0}00', 257, 8, 'ascii');
    header.write(prefix, 345, 155, 'utf8');
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    return header;
}

async function* tarStream(entries: readonly LayerEntry[]): AsyncGenerator<Buffer> {
    for (const entry of entries) {
        yield ustarHeader(entry);
        if (entry.type !== 'file') continue;
        let written = 0;
        if (entry.contents) {
            yield entry.contents;
            written = entry.contents.length;
        } else {
            // eslint-disable-next-line no-await-in-loop -- entries must stream into the archive in order
            for await (const chunk of createReadStream(entry.source!)) {
                written += (chunk as Buffer).length;
                yield chunk as Buffer;
            }
        }
        if (written !== entry.size) throw new Error(`${entry.path} changed while archiving`);
        const padding = (TAR_BLOCK - (written % TAR_BLOCK)) % TAR_BLOCK;
        if (padding) yield Buffer.alloc(padding);
    }
    yield Buffer.alloc(TAR_BLOCK * 2);
}

/**
 * Writes a deterministic `tar.gz` (sorted entries, gzip level 9, gzip header without name or mtime) and returns its
 * SHA-256 and size.
 */
async function writeDeterministicTarGzip(
    entries: readonly LayerEntry[],
    destination: string,
): Promise<{ bytes: number; sha256: string }> {
    const digest = createHash('sha256');
    let bytes = 0;
    const measure = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            // zlib stamps the build host's OS into gzip header byte 9; pin it to Unix (3) so macOS and Linux builders
            // emit identical bytes. The header has no CRC, so this cannot invalidate the stream.
            if (bytes === 0 && chunk.length > 9) {
                chunk = Buffer.from(chunk);
                chunk[9] = 3;
            }
            digest.update(chunk);
            bytes += chunk.length;
            callback(null, chunk);
        },
    });
    const temporary = `${destination}.${process.pid}.tmp`;
    try {
        await pipeline(
            Readable.from(tarStream(entries)),
            createGzip({ level: zlibConstants.Z_BEST_COMPRESSION }),
            measure,
            createWriteStream(temporary),
        );
        await rename(temporary, destination);
    } catch (error) {
        await rm(temporary, { force: true });
        throw error;
    }
    return { bytes, sha256: digest.digest('hex') };
}

/**
 * Builds the application layer for one cross-assembled artifact: every file except the Node runtime, plus a leading
 * `SHA256SUMS` an SSH Host checks before the build is renamed into place.
 */
export async function buildAppLayer(
    artifactRoot: string,
    destination: string,
): Promise<{ bytes: number; files: number; sha256: string }> {
    const entries = await collectLayerEntries(
        artifactRoot,
        new Set([REMOTE_RUNTIME_PATH, REMOTE_CHECKSUMS_FILE]),
    );
    const checksums = Buffer.from(await checksumList(entries));
    const archive: LayerEntry[] = [
        {
            contents: checksums,
            mode: 0o644,
            path: REMOTE_CHECKSUMS_FILE,
            size: checksums.length,
            type: 'file',
        },
        ...entries,
    ];
    const result = await writeDeterministicTarGzip(archive, destination);
    return { ...result, files: entries.filter((entry) => entry.type === 'file').length };
}
