import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { errorMessage } from '../shared/ipc/errors';
import type { UpdateState } from '../shared/types';

const LATEST_RELEASE_URL = 'https://api.github.com/repos/tjx666/caxri/releases/latest';
const MAX_RELEASE_RESPONSE_BYTES = 1024 * 1024;
const MAX_CHECKSUM_BYTES = 4 * 1024;
const MAX_DMG_BYTES = 1024 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 100;
const CHECK_TIMEOUT_MS = 15_000;

const releaseAssetSchema = z.object({
    name: z.string(),
    size: z.number().int().nonnegative(),
    browser_download_url: z.url(),
});

const releaseSchema = z.object({
    tag_name: z.string(),
    draft: z.boolean(),
    prerelease: z.boolean(),
    assets: z.array(releaseAssetSchema),
});

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface AvailableRelease {
    version: string;
    fileName: string;
    dmgUrl: string;
    checksumUrl: string;
    expectedBytes?: number;
}

export interface UpdateServiceOptions {
    currentVersion: string;
    downloadDirectory: string;
    enabled: boolean;
    fetch?: FetchLike;
    now?: () => number;
    onState?(state: UpdateState): void;
    openPath(path: string): Promise<string>;
}

interface AutomaticUpdateCheckOptions {
    alreadyStarted: boolean;
    isE2E: boolean;
    isPackaged: boolean;
}

/**
 * Packaged E2E profiles stay deterministic and must never contact the release service.
 */
export function shouldStartAutomaticUpdateCheck(options: AutomaticUpdateCheckOptions): boolean {
    return options.isPackaged && !options.isE2E && !options.alreadyStarted;
}

function stableVersionParts(version: string): [number, number, number] {
    const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
    if (!match) throw new Error('The release has an unsupported version number.');
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Compares the stable `major.minor.patch` versions used by Caxri releases.
 */
export function compareStableVersions(left: string, right: string): number {
    const leftParts = stableVersionParts(left);
    const rightParts = stableVersionParts(right);
    for (const [index, leftPart] of leftParts.entries()) {
        const difference = leftPart - rightParts[index];
        if (difference !== 0) return Math.sign(difference);
    }
    return 0;
}

function assertSuccessfulResponse(response: Response, label: string): void {
    if (!response.ok) throw new Error(`${label} failed with status ${response.status}.`);
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<Uint8Array> {
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes)
        throw new Error('The update response is larger than expected.');
    if (!response.body) throw new Error('The update response was empty.');

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
        while (true) {
            // Each read must observe the previous chunk before deciding whether to request more,
            // so this stream cannot be drained in parallel.
            // eslint-disable-next-line no-await-in-loop -- sequential stream read, see comment above
            const result = await reader.read();
            if (result.done) break;
            totalBytes += result.value.byteLength;
            if (totalBytes > maximumBytes)
                throw new Error('The update response is larger than expected.');
            chunks.push(result.value);
        }
    } finally {
        reader.releaseLock();
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

function isExactReleaseAssetUrl(url: string, version: string, fileName: string): boolean {
    try {
        const parsed = new URL(url);
        return (
            parsed.protocol === 'https:' &&
            parsed.hostname === 'github.com' &&
            decodeURIComponent(parsed.pathname) ===
                `/tjx666/caxri/releases/download/v${version}/${fileName}`
        );
    } catch {
        return false;
    }
}

function parseChecksum(source: string, fileName: string): string {
    // Parsed without a single combined `\s+\*?` pattern, which is vulnerable to super-linear
    // backtracking; the hex digest, optional binary-mode marker, and file name are each matched
    // independently instead.
    const trimmed = source.trim();
    const separatorIndex = trimmed.search(/\s/);
    if (separatorIndex === -1) throw new Error('The release checksum file is invalid.');
    const hex = trimmed.slice(0, separatorIndex);
    const name = trimmed.slice(separatorIndex).trimStart().replace(/^\*/, '');
    if (name !== fileName || !/^[0-9a-f]{64}$/i.test(hex))
        throw new Error('The release checksum file is invalid.');
    return hex.toLowerCase();
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
}

function updateErrorMessage(error: unknown, fallback: string): string {
    return errorMessage(error, fallback).slice(0, 2_048) || fallback;
}

async function writeAll(file: FileHandle, bytes: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < bytes.byteLength) {
        // Each write must observe the previous write's byte count before advancing the offset,
        // so this cannot be parallelized.
        // eslint-disable-next-line no-await-in-loop -- sequential file write, see comment above
        const { bytesWritten } = await file.write(bytes, offset);
        if (bytesWritten === 0) throw new Error('The update file could not be written.');
        offset += bytesWritten;
    }
}

export class UpdateService {
    private readonly fetch: FetchLike;
    private readonly now: () => number;
    private state: UpdateState;
    private release: AvailableRelease | undefined;
    private readyPath: string | undefined;
    private checkPromise: Promise<UpdateState> | undefined;
    private downloadPromise: Promise<UpdateState> | undefined;
    private downloadController: AbortController | undefined;

    constructor(private readonly options: UpdateServiceOptions) {
        this.fetch = options.fetch ?? globalThis.fetch;
        this.now = options.now ?? Date.now;
        this.state = { status: 'idle', currentVersion: options.currentVersion };
    }

    private publish(state: UpdateState): UpdateState {
        this.state = state;
        this.options.onState?.(state);
        return state;
    }

    private async performCheck(): Promise<UpdateState> {
        try {
            const response = await this.fetch(LATEST_RELEASE_URL, {
                signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
                headers: {
                    'Accept': 'application/vnd.github+json',
                    'User-Agent': `Caxri/${this.options.currentVersion}`,
                    'X-GitHub-Api-Version': '2022-11-28',
                },
            });
            assertSuccessfulResponse(response, 'The GitHub release check');
            const source = new TextDecoder().decode(
                await readBoundedResponse(response, MAX_RELEASE_RESPONSE_BYTES),
            );
            let json: unknown;
            try {
                json = JSON.parse(source) as unknown;
            } catch {
                throw new Error('GitHub returned invalid release metadata.');
            }
            const parsedRelease = releaseSchema.safeParse(json);
            if (!parsedRelease.success)
                throw new Error('GitHub returned invalid release metadata.');
            const release = parsedRelease.data;
            if (release.draft || release.prerelease)
                throw new Error('GitHub returned a non-stable release.');
            const version = release.tag_name.replace(/^v/, '');
            stableVersionParts(version);
            stableVersionParts(this.options.currentVersion);
            if (compareStableVersions(version, this.options.currentVersion) <= 0) {
                this.release = undefined;
                this.readyPath = undefined;
                return this.publish({
                    status: 'up-to-date',
                    currentVersion: this.options.currentVersion,
                });
            }

            const fileName = `Caxri-${version}-arm64.dmg`;
            const checksumName = `${fileName}.sha256`;
            const dmg = release.assets.find((asset) => asset.name === fileName);
            const checksum = release.assets.find((asset) => asset.name === checksumName);
            if (!dmg || !checksum)
                throw new Error('The release is missing its arm64 DMG or checksum.');
            if (dmg.size > MAX_DMG_BYTES || checksum.size > MAX_CHECKSUM_BYTES)
                throw new Error('A release asset is larger than the allowed update size.');
            if (
                !isExactReleaseAssetUrl(dmg.browser_download_url, version, fileName) ||
                !isExactReleaseAssetUrl(checksum.browser_download_url, version, checksumName)
            ) {
                throw new Error('A release asset URL does not match the requested version.');
            }

            this.release = {
                version,
                fileName,
                dmgUrl: dmg.browser_download_url,
                checksumUrl: checksum.browser_download_url,
                ...(dmg.size > 0 && { expectedBytes: dmg.size }),
            };
            this.readyPath = undefined;
            return this.publish({
                status: 'available',
                currentVersion: this.options.currentVersion,
                version,
                fileName,
            });
        } catch (error) {
            return this.publish({
                status: 'error',
                currentVersion: this.options.currentVersion,
                action: 'check',
                message: updateErrorMessage(error, 'Unable to check for updates.'),
            });
        }
    }

    private async performDownload(
        release: AvailableRelease,
        signal: AbortSignal,
    ): Promise<UpdateState> {
        const availableState = (): UpdateState => ({
            status: 'available',
            currentVersion: this.options.currentVersion,
            version: release.version,
            fileName: release.fileName,
        });
        this.publish({
            status: 'downloading',
            currentVersion: this.options.currentVersion,
            version: release.version,
            fileName: release.fileName,
            receivedBytes: 0,
            ...(release.expectedBytes && { totalBytes: release.expectedBytes }),
        });

        const finalPath = join(this.options.downloadDirectory, release.fileName);
        const temporaryPath = `${finalPath}.part`;
        try {
            await mkdir(this.options.downloadDirectory, { recursive: true, mode: 0o700 });
            await rm(temporaryPath, { force: true });

            const checksumResponse = await this.fetch(release.checksumUrl, { signal });
            assertSuccessfulResponse(checksumResponse, 'The checksum download');
            const checksum = parseChecksum(
                new TextDecoder().decode(
                    await readBoundedResponse(checksumResponse, MAX_CHECKSUM_BYTES),
                ),
                release.fileName,
            );

            const response = await this.fetch(release.dmgUrl, { signal });
            assertSuccessfulResponse(response, 'The DMG download');
            if (!response.body) throw new Error('The DMG download was empty.');
            const contentLength = Number(response.headers.get('content-length'));
            const totalBytes =
                Number.isFinite(contentLength) && contentLength > 0
                    ? contentLength
                    : release.expectedBytes;
            if (totalBytes && totalBytes > MAX_DMG_BYTES)
                throw new Error('The DMG is larger than the allowed update size.');
            if (totalBytes && release.expectedBytes && release.expectedBytes !== totalBytes)
                throw new Error('The DMG size does not match the release metadata.');

            const reader = response.body.getReader();
            let file: FileHandle | undefined;
            const hash = createHash('sha256');
            let receivedBytes = 0;
            let lastProgressAt = this.now();
            try {
                file = await open(temporaryPath, 'w', 0o600);
                while (true) {
                    // Each read must observe the previous chunk before deciding whether to request
                    // more, so this stream cannot be drained in parallel.
                    // eslint-disable-next-line no-await-in-loop -- sequential stream read, see comment above
                    const result = await reader.read();
                    if (result.done) break;
                    receivedBytes += result.value.byteLength;
                    if (receivedBytes > MAX_DMG_BYTES)
                        throw new Error('The DMG is larger than the allowed update size.');
                    // The chunk must be fully written to disk before the next chunk is read, so
                    // this write cannot be parallelized with the loop's next iteration.
                    // eslint-disable-next-line no-await-in-loop -- sequential file write, see comment above
                    await writeAll(file, result.value);
                    hash.update(result.value);
                    const now = this.now();
                    if (now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
                        lastProgressAt = now;
                        this.publish({
                            status: 'downloading',
                            currentVersion: this.options.currentVersion,
                            version: release.version,
                            fileName: release.fileName,
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
                throw new Error('The DMG size does not match the release metadata.');
            if (hash.digest('hex') !== checksum)
                throw new Error('The DMG failed SHA-256 verification.');

            await rm(finalPath, { force: true });
            await rename(temporaryPath, finalPath);
            this.readyPath = finalPath;
            return this.publish({
                status: 'ready',
                currentVersion: this.options.currentVersion,
                version: release.version,
                fileName: release.fileName,
            });
        } catch (error) {
            try {
                await rm(temporaryPath, { force: true });
            } catch {
                // Best-effort cleanup; the outer catch already owns the error.
            }
            if (isAbortError(error)) return this.publish(availableState());
            return this.publish({
                status: 'error',
                currentVersion: this.options.currentVersion,
                action: 'download',
                message: updateErrorMessage(error, 'Unable to download the update.'),
                version: release.version,
                fileName: release.fileName,
            });
        }
    }

    getState(): UpdateState {
        return this.state;
    }

    check(): Promise<UpdateState> {
        if (this.checkPromise) return this.checkPromise;
        if (this.downloadPromise) return Promise.resolve(this.state);
        if (!this.options.enabled)
            return Promise.resolve(
                this.publish({
                    status: 'unavailable',
                    currentVersion: this.options.currentVersion,
                    reason: 'Update checks are available in packaged Caxri builds.',
                }),
            );

        this.publish({ status: 'checking', currentVersion: this.options.currentVersion });
        // Coalesces overlapping check() calls onto the same in-flight promise, so this method
        // returns it directly rather than awaiting it itself.
        // eslint-disable-next-line unicorn/prefer-await -- see comment above
        this.checkPromise = this.performCheck().finally(() => {
            this.checkPromise = undefined;
        });
        return this.checkPromise;
    }

    download(): Promise<UpdateState> {
        if (this.downloadPromise) return this.downloadPromise;
        const release = this.release;
        if (!release)
            return Promise.resolve(
                this.publish({
                    status: 'error',
                    currentVersion: this.options.currentVersion,
                    action: 'check',
                    message: 'Check for an available update before downloading it.',
                }),
            );

        this.downloadController = new AbortController();
        // Coalesces overlapping download() calls onto the same in-flight promise, so this method
        // returns it directly rather than awaiting it itself.
        this.downloadPromise = this.performDownload(
            release,
            this.downloadController.signal,
            // eslint-disable-next-line unicorn/prefer-await -- see comment above
        ).finally(() => {
            this.downloadPromise = undefined;
            this.downloadController = undefined;
        });
        return this.downloadPromise;
    }

    async cancel(): Promise<UpdateState> {
        if (!this.downloadController || !this.downloadPromise) return this.state;
        this.downloadController.abort();
        return this.downloadPromise;
    }

    async open(): Promise<UpdateState> {
        const release = this.release;
        if (!release || !this.readyPath)
            return this.publish({
                status: 'error',
                currentVersion: this.options.currentVersion,
                action: 'download',
                message: 'Download and verify the update before opening it.',
                ...(release && { version: release.version, fileName: release.fileName }),
            });
        const error = await this.options.openPath(this.readyPath);
        if (error)
            return this.publish({
                status: 'error',
                currentVersion: this.options.currentVersion,
                action: 'open',
                message: updateErrorMessage(new Error(error), 'Unable to open the update.'),
                version: release.version,
                fileName: release.fileName,
            });
        return this.publish({
            status: 'ready',
            currentVersion: this.options.currentVersion,
            version: release.version,
            fileName: release.fileName,
        });
    }
}
