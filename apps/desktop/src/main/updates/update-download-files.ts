import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Matches the installer names `releaseDmgFileName` produces for every flavor and version.
 */
const UPDATE_INSTALLER_PATTERN = /^Caxri-.+\.dmg$/;

/**
 * Picks the leftovers of earlier updates that are safe to delete before a new download starts.
 *
 * The installer for the release being downloaded and its own `.part` file are kept: the first may already be a complete
 * verified copy, the second may be resumable. Every other `Caxri-*.dmg` is an installer for a release the user never
 * installed or has since replaced, and every other `.part` file belongs to an abandoned download, so they only take
 * disk space (each DMG is hundreds of megabytes). Names outside those two shapes are never returned, so a stray file
 * the user placed in the directory survives.
 */
export function selectStaleUpdateFiles(entries: readonly string[], keepFileName: string): string[] {
    const keepPart = `${keepFileName}.part`;
    return entries.filter((name) => {
        if (name === keepFileName || name === keepPart) return false;
        if (name.endsWith('.part')) return UPDATE_INSTALLER_PATTERN.test(name.slice(0, -5));
        return UPDATE_INSTALLER_PATTERN.test(name);
    });
}

/**
 * Deletes {@link selectStaleUpdateFiles} from the updates directory. Best-effort: a file that cannot be removed only
 * costs disk space and must never fail the download.
 */
export async function removeStaleUpdateFiles(
    directory: string,
    keepFileName: string,
): Promise<void> {
    let entries: string[];
    try {
        entries = await readdir(directory);
    } catch {
        return;
    }
    await Promise.all(
        selectStaleUpdateFiles(entries, keepFileName).map(async (name) => {
            try {
                await rm(join(directory, name), { force: true });
            } catch {
                // See above: leftover files only cost disk space.
            }
        }),
    );
}

/**
 * Streams a file through SHA-256 without holding it in memory. Resolves `undefined` when the file does not exist.
 * `hash` is returned unfinished so a resumed download can keep feeding it the bytes that follow.
 */
export async function hashExistingFile(
    path: string,
): Promise<{ bytes: number; hash: ReturnType<typeof createHash> } | undefined> {
    try {
        const { size } = await stat(path);
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(path)) hash.update(chunk as Uint8Array);
        return { bytes: size, hash };
    } catch {
        return undefined;
    }
}

/**
 * Parses the first byte of a `Content-Range: bytes START-END/TOTAL` header, or `undefined` for any other shape.
 */
export function contentRangeStart(header: string | null): number | undefined {
    if (!header) return undefined;
    const match = /^bytes (\d+)-\d+\/(?:\d+|\*)$/.exec(header.trim());
    return match?.[1] === undefined ? undefined : Number(match[1]);
}

/**
 * Whether a partial file is worth resuming. An empty file gains nothing, and a file already as large as the expected
 * size cannot be a prefix of it (it is either complete, which verification decides, or corrupt).
 */
export function canResumePartial(partialBytes: number, expectedBytes: number | undefined): boolean {
    if (partialBytes <= 0) return false;
    return expectedBytes === undefined || partialBytes < expectedBytes;
}

/**
 * Whether the server honored a Range request for exactly the bytes asked for. Anything else (a plain 200, a different
 * offset) means the body is not the continuation and the caller must restart from zero.
 */
export function isResumedResponse(
    response: { headers: { get(name: string): string | null }; status: number },
    offset: number,
): boolean {
    return (
        response.status === 206 &&
        contentRangeStart(response.headers.get('content-range')) === offset
    );
}
