import { createHash as newHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { UpdateState } from '@caxri/protocol';

import {
    canResumePartial,
    hashExistingFile,
    isResumedResponse,
    removeStaleUpdateFiles,
} from './update-download-files';
import type { UpdateFetch } from './update-service-contract';
import {
    assertSuccessfulResponse,
    isAbortError,
    MAX_CHECKSUM_BYTES,
    MAX_DMG_BYTES,
    parseChecksum,
    PROGRESS_INTERVAL_MS,
    readBoundedResponse,
    readUpdateNetwork,
    updateErrorMessage,
    UpdateFailure,
    updateFailureKind,
    writeAll,
} from './update-transport';

/**
 * The release a download targets: where its files live and what they must hash to.
 */
export interface AvailableRelease {
    checksumUrl: string;
    dmgUrl: string;
    expectedBytes?: number;
    fileName: string;
    releaseUrl?: string;
    version: string;
}

/**
 * What the download needs from the service that owns it, kept narrow so the transfer logic does not reach into
 * `UpdateService` state.
 */
export interface DownloadHost {
    currentVersion: string;
    downloadDirectory: string;
    fetch: UpdateFetch;
    now(): number;
    publish(state: UpdateState): UpdateState;
    setReadyPath(path: string): void;
}

/**
 * Downloads the release DMG into the updates directory and publishes `downloading`, then `ready` (or `available` after
 * a cancel, `error` after a failure). Before transferring anything it removes installers and partial files left by
 * earlier releases, reuses an installer that already matches the published SHA-256, and resumes a partial file when the
 * server supports Range requests; the finished file is verified against the checksum either way.
 */
export async function downloadVerifiedUpdate(
    host: DownloadHost,
    release: AvailableRelease,
    signal: AbortSignal,
): Promise<UpdateState> {
    const releaseFields = {
        version: release.version,
        fileName: release.fileName,
        ...(release.releaseUrl && { releaseUrl: release.releaseUrl }),
    };
    const availableState = (): UpdateState => ({
        status: 'available',
        currentVersion: host.currentVersion,
        ...releaseFields,
    });
    const readyState = (): UpdateState => ({
        status: 'ready',
        currentVersion: host.currentVersion,
        ...releaseFields,
    });
    host.publish({
        status: 'downloading',
        currentVersion: host.currentVersion,
        ...releaseFields,
        receivedBytes: 0,
        ...(release.expectedBytes && { totalBytes: release.expectedBytes }),
    });

    const finalPath = join(host.downloadDirectory, release.fileName);
    const temporaryPath = `${finalPath}.part`;
    try {
        await mkdir(host.downloadDirectory, { recursive: true, mode: 0o700 });
        await removeStaleUpdateFiles(host.downloadDirectory, release.fileName);

        const checksumResponse = await host.fetch(release.checksumUrl, { signal });
        assertSuccessfulResponse(checksumResponse, 'The checksum download');
        const checksum = parseChecksum(
            new TextDecoder().decode(
                await readBoundedResponse(checksumResponse, MAX_CHECKSUM_BYTES),
            ),
            release.fileName,
        );

        // A copy from an earlier attempt that still matches the published digest is the update; downloading it
        // again would spend hundreds of megabytes to produce the same bytes.
        const existing = await hashExistingFile(finalPath);
        if (existing) {
            if (
                existing.hash.digest('hex') === checksum &&
                (!release.expectedBytes || existing.bytes === release.expectedBytes)
            ) {
                host.setReadyPath(finalPath);
                return host.publish(readyState());
            }
            await rm(finalPath, { force: true });
        }

        const { offset, response, hash } = await openDmgResponse(
            host,
            release,
            temporaryPath,
            signal,
        );
        if (!response.body) throw new Error('The DMG download was empty.');
        const contentLength = Number(response.headers.get('content-length'));
        const totalBytes =
            Number.isFinite(contentLength) && contentLength > 0
                ? offset + contentLength
                : release.expectedBytes;
        if (totalBytes && totalBytes > MAX_DMG_BYTES)
            throw new UpdateFailure('integrity', 'The DMG is larger than the allowed update size.');
        if (totalBytes && release.expectedBytes && release.expectedBytes !== totalBytes)
            throw new UpdateFailure(
                'integrity',
                'The DMG size does not match the release metadata.',
            );

        const reader = response.body.getReader();
        let file: FileHandle | undefined;
        let receivedBytes = offset;
        let lastProgressAt = host.now();
        try {
            file = await open(temporaryPath, offset > 0 ? 'a' : 'w', 0o600);
            while (true) {
                // Each read must observe the previous chunk before deciding whether to request
                // more, so this stream cannot be drained in parallel.
                // eslint-disable-next-line no-await-in-loop -- sequential stream read, see comment above
                const result = await readUpdateNetwork(() => reader.read());
                if (result.done) break;
                receivedBytes += result.value.byteLength;
                if (receivedBytes > MAX_DMG_BYTES)
                    throw new UpdateFailure(
                        'integrity',
                        'The DMG is larger than the allowed update size.',
                    );
                // The chunk must be fully written to disk before the next chunk is read, so
                // this write cannot be parallelized with the loop's next iteration.
                // eslint-disable-next-line no-await-in-loop -- sequential file write, see comment above
                await writeAll(file, result.value);
                hash.update(result.value);
                const now = host.now();
                if (now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
                    lastProgressAt = now;
                    host.publish({
                        status: 'downloading',
                        currentVersion: host.currentVersion,
                        ...releaseFields,
                        receivedBytes,
                        ...(totalBytes && { totalBytes }),
                    });
                }
            }
            await file.sync();
        } finally {
            try {
                await reader.cancel();
            } catch {
                // Best-effort cleanup; the outer try already owns the result or error.
            }
            reader.releaseLock();
            await file?.close();
        }
        if (release.expectedBytes && receivedBytes !== release.expectedBytes)
            throw new UpdateFailure(
                'integrity',
                'The DMG size does not match the release metadata.',
            );
        if (hash.digest('hex') !== checksum)
            throw new UpdateFailure('integrity', 'The DMG failed SHA-256 verification.');

        await rm(finalPath, { force: true });
        await rename(temporaryPath, finalPath);
        host.setReadyPath(finalPath);
        return host.publish(readyState());
    } catch (error) {
        // An interrupted transfer keeps its `.part` file so the next attempt can resume it; only bytes that failed
        // verification (or a size contract) are known-bad and must not be resumed.
        if (updateFailureKind(error) === 'integrity') {
            try {
                await rm(temporaryPath, { force: true });
            } catch {
                // Best-effort cleanup; the outer catch already owns the error.
            }
        }
        if (isAbortError(error)) return host.publish(availableState());
        return host.publish({
            status: 'error',
            currentVersion: host.currentVersion,
            action: 'download',
            failureKind: updateFailureKind(error),
            message: updateErrorMessage(error, 'Unable to download the update.'),
            ...releaseFields,
        });
    }
}

/**
 * Requests the DMG, continuing a `.part` file left by an interrupted attempt when the server honors a Range request for
 * exactly the missing tail. Any other answer (no Range support, a different offset, a rejected range, a part file that
 * no longer hashes) falls back to a full download from byte zero, so resuming can only ever save time: the caller
 * verifies the complete file against the published SHA-256 either way.
 *
 * `hash` is primed with the bytes already on disk when resuming, so the final digest covers the whole file.
 */
async function openDmgResponse(
    host: DownloadHost,
    release: AvailableRelease,
    temporaryPath: string,
    signal: AbortSignal,
): Promise<{ hash: ReturnType<typeof newHash>; offset: number; response: Response }> {
    let partialBytes = 0;
    try {
        partialBytes = (await stat(temporaryPath)).size;
    } catch {
        // No partial file: a fresh download.
    }
    if (canResumePartial(partialBytes, release.expectedBytes)) {
        const ranged = await host.fetch(release.dmgUrl, {
            signal,
            headers: { Range: `bytes=${partialBytes}-` },
        });
        if (isResumedResponse(ranged, partialBytes)) {
            const prior = await hashExistingFile(temporaryPath);
            if (prior?.bytes === partialBytes)
                return { hash: prior.hash, offset: partialBytes, response: ranged };
        }
        if (ranged.status === 200) {
            // The server ignored Range and is sending the whole file: use that body rather than asking again.
            await rm(temporaryPath, { force: true });
            return { hash: newHash('sha256'), offset: 0, response: ranged };
        }
        try {
            await ranged.body?.cancel();
        } catch {
            // The body is being discarded; a failed cancel changes nothing.
        }
    }
    await rm(temporaryPath, { force: true });
    const response = await host.fetch(release.dmgUrl, { signal });
    assertSuccessfulResponse(response, 'The DMG download');
    return { hash: newHash('sha256'), offset: 0, response };
}
