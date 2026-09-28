import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { UpdateState } from '@caxri/protocol';
import { compareStableVersions, errorMessage } from '@caxri/protocol';
import { z } from 'zod';

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

type UpdateFailureKind = Extract<UpdateState, { status: 'error' }>['failureKind'];

/**
 * Carries an actionable category without making the Renderer parse platform diagnostics.
 */
class UpdateFailure extends Error {
    constructor(
        readonly kind: UpdateFailureKind,
        message: string,
    ) {
        super(message);
    }
}

function updateFailureKind(error: unknown): UpdateFailureKind {
    return error instanceof UpdateFailure ? error.kind : 'other';
}

async function readUpdateNetwork<T>(operation: () => Promise<T>): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        if (isAbortError(error)) throw error;
        throw new UpdateFailure('network', errorMessage(error, 'The update connection failed.'));
    }
}

interface AvailableRelease {
    version: string;
    fileName: string;
    dmgUrl: string;
    checksumUrl: string;
    expectedBytes?: number;
}

/**
 * Supplies a fixed release in place of the GitHub request for one declared Acceptance case. It never exposes a download
 * URL, so a service built with it can announce an update but can never download or install one.
 */
export interface AcceptanceUpdateDiscovery {
    discover(): Promise<{ fileName: string; version: string }>;
}

export interface UpdateServiceOptions {
    /**
     * Present only when `createAcceptanceUpdateFixture` admitted (or visibly rejected) an Acceptance request. It
     * replaces the network discovery and lets an unpackaged Acceptance build check for updates without ever enabling
     * the real release service.
     */
    acceptanceDiscovery?: AcceptanceUpdateDiscovery;
    currentVersion: string;
    downloadDirectory: string;
    /**
     * The packaged-build gate for real release checks.
     */
    enabled: boolean;
    fetch?: FetchLike;
    now?: () => number;
    onState?(state: UpdateState): void;
    openPath(path: string): Promise<string>;
}

interface AutomaticUpdateCheckOptions {
    alreadyStarted: boolean;
    hasAcceptanceDiscovery?: boolean;
    isE2E: boolean;
    isPackaged: boolean;
}

/**
 * Packaged E2E profiles stay deterministic and must never contact the release service. An admitted Acceptance fixture
 * is the one exception that runs the launch check off the network, so its notification arrives the same way a real
 * automatic discovery does.
 */
export function shouldStartAutomaticUpdateCheck(options: AutomaticUpdateCheckOptions): boolean {
    if (options.alreadyStarted) return false;
    return options.hasAcceptanceDiscovery === true || (options.isPackaged && !options.isE2E);
}

/**
 * Rejects a release tag Caxri cannot order. Shares `compareStableVersions`' parser so the shape Main accepts here and
 * the shape the Renderer can compare a skipped version against can never drift apart.
 */
function assertStableVersion(version: string): void {
    compareStableVersions(version, version);
}

function assertSuccessfulResponse(response: Response, label: string): void {
    if (!response.ok)
        throw new UpdateFailure('network', `${label} failed with status ${response.status}.`);
}

/**
 * `true` for both GitHub's primary (403, once the anonymous per-hour quota is exhausted) and secondary (429, once
 * requests arrive too quickly) rate limits on the release check. Both are expected, temporary conditions rather than a
 * Caxri defect, so they degrade to `unavailable` the same way the pre-release 404 case does (#244) instead of surfacing
 * a permanent, retried-every-launch `error`.
 */
function isRateLimitedStatus(status: number): boolean {
    return status === 403 || status === 429;
}

/**
 * Reads GitHub's rate-limit reset hint from the response so the next automatic check can skip the network call entirely
 * until the limit clears, instead of hammering an endpoint that is already rejecting requests. `retry-after` is a
 * relative delay in seconds (used for secondary/abuse limits); `x-ratelimit-reset` is an absolute Unix epoch in seconds
 * (used for the primary hourly limit). Returns `undefined` when neither header is present, in which case the caller
 * does not open a skip window.
 */
function rateLimitResumeAt(response: Response, now: number): number | undefined {
    const retryAfterSeconds = Number(response.headers.get('retry-after'));
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0)
        return now + retryAfterSeconds * 1_000;
    const resetEpochSeconds = Number(response.headers.get('x-ratelimit-reset'));
    if (Number.isFinite(resetEpochSeconds) && resetEpochSeconds > 0)
        return resetEpochSeconds * 1_000;
    return undefined;
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
            const result = await readUpdateNetwork(() => reader.read());
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
    if (separatorIndex === -1)
        throw new UpdateFailure('integrity', 'The release checksum file is invalid.');
    const hex = trimmed.slice(0, separatorIndex);
    const name = trimmed.slice(separatorIndex).trimStart().replace(/^\*/, '');
    if (name !== fileName || !/^[0-9a-f]{64}$/i.test(hex))
        throw new UpdateFailure('integrity', 'The release checksum file is invalid.');
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

/**
 * Structured-log fields for an `updates.state` transition. Error and unavailable states carry their diagnostic context
 * (`action`/`message`/`reason`); without them the log record degrades to an undiagnosable `{"status":"error"}` (#244).
 */
export function updateStateLogFields(state: UpdateState): Record<string, string | null> {
    return {
        status: state.status,
        ...('version' in state && { version: state.version ?? null }),
        ...(state.status === 'error' && {
            action: state.action,
            failureKind: state.failureKind,
            message: state.message,
        }),
        ...(state.status === 'unavailable' && {
            reason: state.reason,
            /**
             * A rate-limited `unavailable` is a wait, not a fault, and the two are indistinguishable in a log record
             * that only carries the prose `reason`. Recording the deadline as well is what makes "how long was update
             * discovery actually paused" answerable from logs nobody filed a bug about.
             */
            rateLimited: String(state.rateLimited === true),
            retryAt: state.retryAt === undefined ? null : new Date(state.retryAt).toISOString(),
        }),
    };
}

/**
 * Message for the one `unavailable` cause a manual check can still get past. It deliberately stops at the fact; the
 * Renderer owns the clock time and the "checking now bypasses the wait" half, because the deadline has to be compared
 * against the reader's current time rather than the moment the state was published.
 */
const RATE_LIMITED_REASON = 'Update checks are rate limited by GitHub right now.';

export class UpdateService {
    private readonly fetch: FetchLike;
    private readonly now: () => number;
    private state: UpdateState;
    private release: AvailableRelease | undefined;
    private readyPath: string | undefined;
    private checkPromise: Promise<UpdateState> | undefined;
    private downloadPromise: Promise<UpdateState> | undefined;
    private downloadController: AbortController | undefined;
    /**
     * Epoch millis before which `check()` skips the network call because GitHub already rate-limited the previous
     * attempt. `undefined` when no rate limit is currently known.
     */
    private rateLimitedUntil: number | undefined;
    /**
     * The version a window has already offered the user in this app process, recorded by `acknowledge()`. Memory-only
     * on purpose: it is the storage that makes `Close` mean "not now" for this run, where `updates.skippedVersion`
     * makes `Skip this version` outlast the process.
     */
    private announcedVersion: string | undefined;
    /**
     * The release the Acceptance fixture served in this launch. The fixture serves once, so every later check —
     * including one after the disabled download left an error — republishes this instead of consuming it again.
     */
    private acceptanceRelease: { fileName: string; version: string } | undefined;
    private isAutomaticCheckStarted = false;

    constructor(private readonly options: UpdateServiceOptions) {
        const fetch = options.fetch ?? globalThis.fetch;
        this.fetch = (input, init) => readUpdateNetwork(() => fetch(input, init));
        this.now = options.now ?? Date.now;
        this.state = { status: 'idle', currentVersion: options.currentVersion };
    }

    /**
     * Stamps `announced` onto every `available` state as it leaves the service, so a reload and a cancelled download
     * both re-read the state this process already offered instead of reading a fresh discovery.
     */
    private publish(state: UpdateState): UpdateState {
        const stamped: UpdateState =
            state.status === 'available'
                ? { ...state, announced: this.announcedVersion === state.version }
                : state;
        this.state = stamped;
        this.options.onState?.(stamped);
        return stamped;
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
            // While the repository is private, the anonymous releases API returns 404 for every
            // check. That is an expected pre-release condition, not a fault, so it degrades to
            // `unavailable` instead of surfacing a permanent error on every launch (#244).
            if (response.status === 404) {
                this.release = undefined;
                this.readyPath = undefined;
                return this.publish({
                    status: 'unavailable',
                    currentVersion: this.options.currentVersion,
                    reason: 'The Caxri release feed is not publicly available yet.',
                });
            }
            // GitHub's anonymous release API is subject to both a per-hour primary limit (403) and a
            // burst secondary limit (429). Both are expected, temporary conditions rather than a
            // Caxri defect, so this degrades to `unavailable` the same way the 404 pre-release case
            // does above (#244), and remembers when it is safe to retry so a repeated automatic check
            // does not immediately re-trigger the same limit.
            if (isRateLimitedStatus(response.status)) {
                this.release = undefined;
                this.readyPath = undefined;
                this.rateLimitedUntil = rateLimitResumeAt(response, this.now());
                return this.publish({
                    status: 'unavailable',
                    currentVersion: this.options.currentVersion,
                    reason: RATE_LIMITED_REASON,
                    rateLimited: true,
                    ...(this.rateLimitedUntil !== undefined && { retryAt: this.rateLimitedUntil }),
                });
            }
            assertSuccessfulResponse(response, 'The GitHub release check');
            // A successful, non-rate-limited response means the previous rate limit (if any) has cleared.
            this.rateLimitedUntil = undefined;
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
            assertStableVersion(version);
            assertStableVersion(this.options.currentVersion);
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
                throw new UpdateFailure(
                    'integrity',
                    'The release is missing its arm64 DMG or checksum.',
                );
            if (dmg.size > MAX_DMG_BYTES || checksum.size > MAX_CHECKSUM_BYTES)
                throw new UpdateFailure(
                    'integrity',
                    'A release asset is larger than the allowed update size.',
                );
            if (
                !isExactReleaseAssetUrl(dmg.browser_download_url, version, fileName) ||
                !isExactReleaseAssetUrl(checksum.browser_download_url, version, checksumName)
            ) {
                throw new UpdateFailure(
                    'integrity',
                    'A release asset URL does not match the requested version.',
                );
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
                failureKind: updateFailureKind(error),
                message: updateErrorMessage(error, 'Unable to check for updates.'),
            });
        }
    }

    private publishAcceptanceRelease(release: { fileName: string; version: string }): UpdateState {
        return this.publish({
            status: 'available',
            currentVersion: this.options.currentVersion,
            version: release.version,
            fileName: release.fileName,
        });
    }

    private async performAcceptanceCheck(
        discovery: AcceptanceUpdateDiscovery,
    ): Promise<UpdateState> {
        try {
            const { fileName, version } = await discovery.discover();
            assertStableVersion(version);
            if (compareStableVersions(version, this.options.currentVersion) <= 0)
                throw new Error('The Acceptance update fixture must be newer than this build.');
            // No `release` is recorded: without a download URL, `download()` and `open()` stay unreachable.
            this.release = undefined;
            this.readyPath = undefined;
            this.acceptanceRelease = { fileName, version };
            return this.publishAcceptanceRelease(this.acceptanceRelease);
        } catch (error) {
            return this.publish({
                status: 'error',
                currentVersion: this.options.currentVersion,
                action: 'check',
                failureKind: 'other',
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
                throw new UpdateFailure(
                    'integrity',
                    'The DMG is larger than the allowed update size.',
                );
            if (totalBytes && release.expectedBytes && release.expectedBytes !== totalBytes)
                throw new UpdateFailure(
                    'integrity',
                    'The DMG size does not match the release metadata.',
                );

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
                throw new UpdateFailure(
                    'integrity',
                    'The DMG size does not match the release metadata.',
                );
            if (hash.digest('hex') !== checksum)
                throw new UpdateFailure('integrity', 'The DMG failed SHA-256 verification.');

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
                failureKind: updateFailureKind(error),
                message: updateErrorMessage(error, 'Unable to download the update.'),
                version: release.version,
                fileName: release.fileName,
            });
        }
    }

    getState(): UpdateState {
        return this.state;
    }

    /**
     * Records that a window has offered the currently available version to the user — through the notification or by
     * opening the update dialog. Every later read of this state reports `announced: true`, so a window reload, a
     * cancelled download returning to `available`, or a second window never produce a second prompt for the same
     * release. Nothing is written to disk: the next launch offers it again unless the user skipped it.
     *
     * A no-op for every other status, including an `available` state that has since been superseded.
     */
    acknowledge(): Promise<UpdateState> {
        if (this.state.status !== 'available') return Promise.resolve(this.state);
        this.announcedVersion = this.state.version;
        // Stored rather than published: nothing about the release changed, and broadcasting `updates.state` here would
        // hand the acknowledging window back the state it just acted on.
        this.state = { ...this.state, announced: true };
        return Promise.resolve(this.state);
    }

    /**
     * `manual` marks a user-initiated check. It bypasses the locally recorded rate-limit window because the user
     * explicitly accepted a fresh network round trip; the automatic launch check keeps honoring the window.
     */
    check(options: { manual?: boolean } = {}): Promise<UpdateState> {
        if (this.checkPromise) return this.checkPromise;
        if (this.downloadPromise) return Promise.resolve(this.state);
        const { acceptanceDiscovery } = this.options;
        if (acceptanceDiscovery && this.acceptanceRelease)
            return Promise.resolve(
                this.state.status === 'available'
                    ? this.state
                    : this.publishAcceptanceRelease(this.acceptanceRelease),
            );
        if (!acceptanceDiscovery && !this.options.enabled)
            return Promise.resolve(
                this.publish({
                    status: 'unavailable',
                    currentVersion: this.options.currentVersion,
                    reason: 'Update checks are available in packaged Caxri builds.',
                }),
            );
        /**
         * Skip the network call entirely while still inside a previously recorded GitHub rate-limit window (see
         * `performCheck`'s 403/429 handling). This is what keeps the automatic launch check from immediately
         * re-triggering the same limit; a later `check()` call after the window elapses tries the network again.
         */
        if (
            !options.manual &&
            this.rateLimitedUntil !== undefined &&
            this.now() < this.rateLimitedUntil
        )
            return Promise.resolve(
                this.publish({
                    status: 'unavailable',
                    currentVersion: this.options.currentVersion,
                    reason: RATE_LIMITED_REASON,
                    rateLimited: true,
                    retryAt: this.rateLimitedUntil,
                }),
            );

        this.publish({ status: 'checking', currentVersion: this.options.currentVersion });
        // Coalesces overlapping check() calls onto the same in-flight promise, so this method
        // returns it directly rather than awaiting it itself.
        const discovery = acceptanceDiscovery
            ? this.performAcceptanceCheck(acceptanceDiscovery)
            : this.performCheck();
        // eslint-disable-next-line unicorn/prefer-await -- see comment above
        this.checkPromise = discovery.finally(() => {
            this.checkPromise = undefined;
        });
        return this.checkPromise;
    }

    /**
     * Starts the one automatic launch check this process makes. Discovery stays off the awaited startup path and never
     * delays the first window; `check()` publishes failures through its own state, so this is fire-and-forget.
     */
    startAutomaticCheck(options: { isE2E: boolean }): void {
        if (
            !shouldStartAutomaticUpdateCheck({
                alreadyStarted: this.isAutomaticCheckStarted,
                hasAcceptanceDiscovery: this.options.acceptanceDiscovery !== undefined,
                isE2E: options.isE2E,
                isPackaged: this.options.enabled,
            })
        )
            return;
        this.isAutomaticCheckStarted = true;
        // eslint-disable-next-line unicorn/prefer-await -- see the method comment
        this.check().catch(() => {});
    }

    download(): Promise<UpdateState> {
        if (this.downloadPromise) return this.downloadPromise;
        if (this.options.acceptanceDiscovery)
            return Promise.resolve(
                this.publish({
                    status: 'error',
                    failureKind: 'other',
                    currentVersion: this.options.currentVersion,
                    action: 'download',
                    message: 'Update downloads are disabled in Acceptance launches.',
                    ...(this.state.status === 'available' && {
                        version: this.state.version,
                        fileName: this.state.fileName,
                    }),
                }),
            );
        const release = this.release;
        if (!release)
            return Promise.resolve(
                this.publish({
                    status: 'error',
                    failureKind: 'other',
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
                failureKind: 'other',
                currentVersion: this.options.currentVersion,
                action: 'download',
                message: 'Download and verify the update before opening it.',
                ...(release && { version: release.version, fileName: release.fileName }),
            });
        const error = await this.options.openPath(this.readyPath);
        if (error)
            return this.publish({
                status: 'error',
                failureKind: 'other',
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
