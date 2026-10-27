import type { UpdateState } from '@caxri/protocol';
import { compareStableVersions } from '@caxri/protocol';

import { releaseDmgFileName } from '../source-map-flavor';
import type { AvailableRelease } from './update-download';
import { downloadVerifiedUpdate } from './update-download';
import {
    assertStableVersion,
    isExactReleaseAssetUrl,
    isRateLimitedStatus,
    LATEST_RELEASE_URL,
    rateLimitResumeAt,
    releasePageUrl,
    releaseSchema,
} from './update-github-release';
import type {
    AcceptanceUpdateDiscovery,
    UpdateFetch,
    UpdateServiceOptions,
} from './update-service-contract';
import {
    assertSuccessfulResponse,
    MAX_CHECKSUM_BYTES,
    MAX_DMG_BYTES,
    MAX_RELEASE_RESPONSE_BYTES,
    readBoundedResponse,
    readUpdateNetwork,
    updateErrorMessage,
    UpdateFailure,
    updateFailureKind,
} from './update-transport';

const CHECK_TIMEOUT_MS = 15_000;
/**
 * How often a long-running Caxri asks again. Six hours keeps a Mac that stays open for days current while spending a
 * fraction of GitHub's anonymous hourly quota.
 */
const BACKGROUND_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;
/**
 * A wake from sleep re-checks only when the last attempt is at least this old, so closing and opening a lid repeatedly
 * does not turn into a request per wake.
 */
export const RESUME_CHECK_MIN_GAP_MS = 30 * 60 * 1_000;

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

interface BackgroundCheckInput {
    isCheckInFlight: boolean;
    lastAttemptAt: number | undefined;
    minGapMs: number;
    now: number;
    status: UpdateState['status'];
}

/**
 * Whether a timer or wake-from-sleep re-check may run. A download in progress or a verified installer waiting for the
 * user must never be replaced by a fresh discovery, a check already in flight is not repeated, and a recent attempt
 * (including one that GitHub rate-limited) is not retried before `minGapMs` has passed.
 */
export function shouldRunBackgroundCheck(input: BackgroundCheckInput): boolean {
    if (input.isCheckInFlight) return false;
    if (input.status === 'downloading' || input.status === 'ready') return false;
    return input.lastAttemptAt === undefined || input.now - input.lastAttemptAt >= input.minGapMs;
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
    private readonly fetch: UpdateFetch;
    private readonly now: () => number;
    private state: UpdateState;
    private release: AvailableRelease | undefined;
    private readyPath: string | undefined;
    /**
     * How the verified installer at {@link readyPath} installs; see `installMode` on the `ready` state.
     */
    private installMode: 'manual' | 'restart' = 'manual';
    private checkPromise: Promise<UpdateState> | undefined;
    private downloadPromise: Promise<UpdateState> | undefined;
    private downloadController: AbortController | undefined;
    /**
     * Epoch millis before which `check()` skips the network call because GitHub already rate-limited the previous
     * attempt. `undefined` when no rate limit is currently known.
     */
    private rateLimitedUntil: number | undefined;
    /**
     * The `status:version` pairs a window has already offered the user in this app process, recorded by
     * `acknowledge()`. Keyed by status as well because `available` and `ready` are separate offers: the first asks
     * whether to download, the second whether to restart. Memory-only on purpose: it is the storage that makes `Close`
     * mean "not now" for this run, where `updates.skippedVersion` makes `Skip this version` outlast the process.
     */
    private readonly announcedOffers = new Set<string>();
    /**
     * The release the Acceptance fixture served in this launch. The fixture serves once, so every later check (
     * including one after the disabled download left an error) republishes this instead of consuming it again.
     */
    private acceptanceRelease: { fileName: string; version: string } | undefined;
    private isAutomaticCheckStarted = false;
    private lastCheckAttemptAt: number | undefined;
    /**
     * The version this launch replaced, stamped on every published state until a window acknowledges it. `undefined`
     * after the acknowledgement and for any launch that did not follow an update.
     */
    private updatedFrom: string | undefined;

    constructor(private readonly options: UpdateServiceOptions) {
        const fetch = options.fetch ?? globalThis.fetch;
        this.fetch = (input, init) => readUpdateNetwork(() => fetch(input, init));
        this.now = options.now ?? Date.now;
        this.state = this.stampLaunch({ status: 'idle', currentVersion: options.currentVersion });
    }

    private stampLaunch(state: UpdateState): UpdateState {
        return this.updatedFrom === undefined ? state : { ...state, updatedFrom: this.updatedFrom };
    }

    /**
     * Stamps `announced` onto every `available` state as it leaves the service, so a reload and a cancelled download
     * both re-read the state this process already offered instead of reading a fresh discovery.
     */
    private publish(state: UpdateState): UpdateState {
        const stamped: UpdateState =
            state.status === 'available' || state.status === 'ready'
                ? {
                      ...state,
                      announced: this.announcedOffers.has(`${state.status}:${state.version}`),
                  }
                : state;
        const launchStamped = this.stampLaunch(stamped);
        this.state = launchStamped;
        this.options.onState?.(launchStamped);
        return launchStamped;
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

            const releaseUrl = releasePageUrl(release.html_url);
            const fileName = releaseDmgFileName(version, this.options.sourceMapFlavor ?? 'include');
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
                ...(releaseUrl && { releaseUrl }),
                ...(dmg.size > 0 && { expectedBytes: dmg.size }),
            };
            this.readyPath = undefined;
            return this.publish({
                status: 'available',
                currentVersion: this.options.currentVersion,
                version,
                fileName,
                ...(releaseUrl && { releaseUrl }),
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

    /**
     * Captures what a background re-check must put back when it fails. A flaky network or a rate limit says nothing
     * about the release already on offer, so the failure is not allowed to replace an `available` or `up-to-date` state
     * (or the release record `download()` needs) the user can already see.
     */
    private snapshotForBackgroundCheck(): (result: UpdateState) => UpdateState | undefined {
        const previousState = this.state;
        const previousRelease = this.release;
        const previousReadyPath = this.readyPath;
        return (result) => {
            const isFailed = result.status === 'error' || result.status === 'unavailable';
            const isRestorable =
                previousState.status === 'available' || previousState.status === 'up-to-date';
            if (!isFailed || !isRestorable) return;
            this.release = previousRelease;
            this.readyPath = previousReadyPath;
            return this.publish(previousState);
        };
    }

    /**
     * Awaits one discovery, lets a background check put back the state it must not clobber, and clears the in-flight
     * marker so the next `check()` starts fresh.
     */
    private async settleCheck(
        discovery: Promise<UpdateState>,
        settled: ((result: UpdateState) => UpdateState | undefined) | undefined,
    ): Promise<UpdateState> {
        try {
            const state = await discovery;
            return settled?.(state) ?? state;
        } finally {
            this.checkPromise = undefined;
        }
    }

    private readyState(release: AvailableRelease): UpdateState {
        return {
            status: 'ready',
            currentVersion: this.options.currentVersion,
            version: release.version,
            fileName: release.fileName,
            ...(release.releaseUrl && { releaseUrl: release.releaseUrl }),
            installMode: this.installMode,
        };
    }

    private async prepareReady(path: string, version: string): Promise<'manual' | 'restart'> {
        this.readyPath = path;
        let mode: 'manual' | 'restart' = 'manual';
        try {
            mode = (await this.options.prepareInstall?.({ dmgPath: path, version })) ?? 'manual';
        } catch {
            // `prepareInstall` reports its own failures; any escape still leaves the DMG to open by hand.
        }
        this.installMode = mode;
        return mode;
    }

    private isRestartReady(): boolean {
        return (
            this.state.status === 'ready' &&
            this.state.installMode === 'restart' &&
            this.readyPath !== undefined &&
            this.options.launchInstall !== undefined
        );
    }

    /**
     * Records the version this launch replaced (read from the profile after startup) and republishes the current state
     * stamped with it, so the Renderer raises the one-time "Updated to" notice.
     */
    announceUpdatedFrom(version: string): void {
        this.updatedFrom = version;
        this.publish(this.state);
    }

    getState(): UpdateState {
        return this.state;
    }

    /**
     * Records that a window has offered the currently available version to the user, through the notification or by
     * opening the update dialog. Every later read of this state reports `announced: true`, so a window reload, a
     * cancelled download returning to `available`, or a second window never produce a second prompt for the same
     * release. Nothing is written to disk: the next launch offers it again unless the user skipped it.
     *
     * The same holds for `ready`, whose notification offers the restart. Acknowledging a version as `available` does
     * not silence its later `ready` notification: each status is a separate offer.
     *
     * A no-op for every other status, including an `available` state that has since been superseded.
     */
    acknowledge(): Promise<UpdateState> {
        if (this.updatedFrom !== undefined) {
            // The one-time "Updated to" notice has been raised; stop stamping it so a reload does not repeat it.
            this.updatedFrom = undefined;
            const next = { ...this.state };
            delete next.updatedFrom;
            this.state = next;
        }
        if (this.state.status !== 'available' && this.state.status !== 'ready')
            return Promise.resolve(this.state);
        this.announcedOffers.add(`${this.state.status}:${this.state.version}`);
        // Stored rather than published: nothing about the release changed, and broadcasting `updates.state` here would
        // hand the acknowledging window back the state it just acted on.
        this.state = { ...this.state, announced: true };
        return Promise.resolve(this.state);
    }

    /**
     * `manual` marks a user-initiated check. It bypasses the locally recorded rate-limit window because the user
     * explicitly accepted a fresh network round trip; the automatic launch check keeps honoring the window.
     */
    check(options: { background?: boolean; manual?: boolean } = {}): Promise<UpdateState> {
        if (this.checkPromise) return this.checkPromise;
        if (this.downloadPromise) return Promise.resolve(this.state);
        // A staged update stays put until the restart or quit that installs it: a re-check would replace `ready` and
        // leave a confirmed Restart to Update with nothing to install.
        if (this.isRestartReady()) return Promise.resolve(this.state);
        // A download or open failure is still on screen; a silent re-check must not replace it with `available`.
        // A failed check is different: re-checking is how it recovers, so it stays eligible.
        if (options.background && this.state.status === 'error' && this.state.action !== 'check')
            return Promise.resolve(this.state);
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
        ) {
            // A background re-check inside the window must not replace a visible `available` or `up-to-date` state.
            if (options.background) return Promise.resolve(this.state);
            return Promise.resolve(
                this.publish({
                    status: 'unavailable',
                    currentVersion: this.options.currentVersion,
                    reason: RATE_LIMITED_REASON,
                    rateLimited: true,
                    retryAt: this.rateLimitedUntil,
                }),
            );
        }

        this.lastCheckAttemptAt = this.now();
        // A background re-check stays invisible: publishing `checking` would blank an `available` chip every six hours.
        if (!options.background)
            this.publish({ status: 'checking', currentVersion: this.options.currentVersion });
        const settled = options.background ? this.snapshotForBackgroundCheck() : undefined;
        // Coalesces overlapping check() calls onto the same in-flight promise, so this method
        // returns it directly rather than awaiting it itself.
        const discovery = acceptanceDiscovery
            ? this.performAcceptanceCheck(acceptanceDiscovery)
            : this.performCheck();

        this.checkPromise = this.settleCheck(discovery, settled);
        return this.checkPromise;
    }

    /**
     * Starts the automatic launch check this process makes, then keeps the answer fresh: a re-check every
     * {@link BACKGROUND_CHECK_INTERVAL_MS} and one after the Mac wakes from sleep (`subscribeResume`, injected so this
     * class stays free of Electron). Both ride `check()`, so its rate-limit window and in-flight coalescing apply, and
     * `announced` keeps a version that was already offered from raising a second notification. Discovery stays off the
     * awaited startup path and never delays the first window; `check()` publishes failures through its own state, so
     * this is fire-and-forget.
     */
    startAutomaticCheck(options: {
        isE2E: boolean;
        subscribeResume?: (onResume: () => void) => void;
    }): void {
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
        const recheck = (minGapMs: number): void => {
            if (
                !shouldRunBackgroundCheck({
                    isCheckInFlight: this.checkPromise !== undefined,
                    lastAttemptAt: this.lastCheckAttemptAt,
                    minGapMs,
                    now: this.now(),
                    status: this.state.status,
                })
            )
                return;
            // eslint-disable-next-line unicorn/prefer-await -- fire-and-forget, see the method comment
            this.check({ background: true }).catch(() => {});
        };
        // The timer must never keep the process alive on its own.
        setInterval(() => recheck(0), BACKGROUND_CHECK_INTERVAL_MS).unref();
        options.subscribeResume?.(() => recheck(RESUME_CHECK_MIN_GAP_MS));
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
        this.downloadPromise = downloadVerifiedUpdate(
            {
                currentVersion: this.options.currentVersion,
                downloadDirectory: this.options.downloadDirectory,
                fetch: this.fetch,
                now: this.now,
                prepareReady: (path) => this.prepareReady(path, release.version),
                publish: (state) => this.publish(state),
            },
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
        return this.publish(this.readyState(release));
    }

    /**
     * `updates.install`: restarts into the staged update through the ordinary quit confirmations. Resolves with the
     * unchanged state when the user cancels; a confirmed restart exits Main before this settles.
     */
    async install(): Promise<UpdateState> {
        const release = this.release;
        if (!release || !this.isRestartReady() || !this.options.restartToUpdate)
            return this.publish({
                status: 'error',
                failureKind: 'other',
                currentVersion: this.options.currentVersion,
                action: 'install',
                message: 'Download and verify the update before restarting to install it.',
                ...(release && { version: release.version, fileName: release.fileName }),
            });
        await this.options.restartToUpdate();
        return this.state;
    }

    /**
     * Called by the quit flow once Server Core has stopped and Main is about to exit. Starts the in-place install when
     * a staged update is waiting, so an ordinary quit installs it too and the next launch is the new version. Resolves
     * `false` when there was nothing to install.
     */
    async applyOnExit(options: { relaunch: boolean }): Promise<boolean> {
        const release = this.release;
        if (!release || !this.isRestartReady()) return false;
        await this.options.launchInstall!({ relaunch: options.relaunch, version: release.version });
        return true;
    }
}
