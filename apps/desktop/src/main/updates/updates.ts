import type { UpdateState } from '@caxri/protocol';
import { compareStableVersions } from '@caxri/protocol';

import {
    BACKGROUND_CHECK_INTERVAL_MS,
    RESUME_CHECK_MIN_GAP_MS,
    shouldRunBackgroundCheck,
    shouldStartAutomaticUpdateCheck,
} from './discovery/background-check';
import { LatestReleaseFinder } from './discovery/latest-release';
import { supersedeStagedUpdate } from './discovery/supersede';
import type { AvailableRelease } from './update-download';
import { downloadVerifiedUpdate } from './update-download';
import { assertStableVersion } from './update-github-release';
import type {
    AcceptanceUpdateDiscovery,
    PreparedInstall,
    UpdateFetch,
    UpdateServiceOptions,
} from './update-service-contract';
import { readUpdateNetwork, updateErrorMessage, updateFailureKind } from './update-transport';

export class UpdateService {
    private readonly fetch: UpdateFetch;
    private readonly now: () => number;
    private readonly latestRelease: LatestReleaseFinder;
    private state: UpdateState;
    private release: AvailableRelease | undefined;
    private readyPath: string | undefined;
    /**
     * How the verified installer at {@link readyPath} installs; see `installMode` on the `ready` state.
     */
    private prepared: PreparedInstall = { installMode: 'manual' };
    /**
     * The newer release a silent supersede already failed to download or stage in this process. The 15-minute re-check
     * skips it instead of fetching the whole DMG again every tick; a later release or a relaunch tries again.
     */
    private supersedeFailedVersion: string | undefined;
    /**
     * The data-resetting version the user agreed to install from `confirmDataReset`; nothing else may install it.
     */
    private dataResetConfirmedFor: string | undefined;
    private checkPromise: Promise<UpdateState> | undefined;
    private downloadPromise: Promise<UpdateState> | undefined;
    private downloadController: AbortController | undefined;
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
        this.latestRelease = new LatestReleaseFinder({
            currentVersion: options.currentVersion,
            fetch: this.fetch,
            now: this.now,
            sourceMapFlavor: options.sourceMapFlavor ?? 'include',
        });
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
            const discovery = await this.latestRelease.discover();
            if (discovery.kind !== 'release') {
                this.release = undefined;
                this.readyPath = undefined;
                return this.publish({
                    status: 'unavailable',
                    currentVersion: this.options.currentVersion,
                    ...(discovery.kind === 'rate-limited'
                        ? {
                              reason: 'rate-limited',
                              ...(discovery.retryAt !== undefined && {
                                  retryAt: discovery.retryAt,
                              }),
                          }
                        : { reason: 'feed-unavailable' }),
                });
            }
            const { release } = discovery;
            if (!release) {
                this.release = undefined;
                this.readyPath = undefined;
                return this.publish({
                    status: 'up-to-date',
                    currentVersion: this.options.currentVersion,
                });
            }
            this.release = release;
            this.readyPath = undefined;
            return this.publish({
                status: 'available',
                currentVersion: this.options.currentVersion,
                version: release.version,
                fileName: release.fileName,
                ...(release.releaseUrl && { releaseUrl: release.releaseUrl }),
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

    /**
     * The background re-check while a verified installer is already `ready`: looks for a release newer than the staged
     * one and, when there is one, downloads and stages it without touching the visible state. Restart to Update keeps
     * installing the staged version until the newer one is fully staged, then the state swaps to it and is announced
     * like any new `ready` offer. A rate limit, a failed request, or a failed download is invisible: the ready state
     * the user already has stays exactly as it was, and the next tick tries again.
     *
     * Staging the newer bundle empties the shared staging directory, so a newer bundle that fails to stage restages the
     * old one before giving up. The few seconds in between are the only window where a quit installs nothing.
     */
    private async supersedeReady(
        staged: AvailableRelease,
        stagedPath: string,
    ): Promise<UpdateState> {
        const keep = this.state;
        const result = await supersedeStagedUpdate({
            currentVersion: this.options.currentVersion,
            downloadDirectory: this.options.downloadDirectory,
            failedVersion: this.supersedeFailedVersion,
            fetch: this.fetch,
            now: this.now,
            prepareInstall: (input) => this.options.prepareInstall?.(input),
            previous: this.prepared,
            discoverLatest: async () => {
                const discovery = await this.latestRelease.discover();
                return discovery.kind === 'release' ? discovery.release : undefined;
            },
            staged,
            stagedPath,
        });
        if (result.kind === 'keep') {
            this.supersedeFailedVersion = result.failedVersion;
            return keep;
        }
        this.supersedeFailedVersion = undefined;
        this.release = result.release;
        this.readyPath = result.path;
        this.prepared = result.prepared;
        this.dataResetConfirmedFor = undefined;
        return this.publish(this.readyState(result.release));
    }

    private readyState(
        release: Pick<AvailableRelease, 'fileName' | 'releaseUrl' | 'version'>,
    ): UpdateState {
        return {
            status: 'ready',
            currentVersion: this.options.currentVersion,
            version: release.version,
            fileName: release.fileName,
            ...(release.releaseUrl && { releaseUrl: release.releaseUrl }),
            ...this.prepared,
        };
    }

    private async prepareReady(path: string, version: string): Promise<PreparedInstall> {
        this.readyPath = path;
        this.dataResetConfirmedFor = undefined;
        let prepared: PreparedInstall = { installMode: 'manual' };
        try {
            prepared =
                (await this.options.prepareInstall?.({ dmgPath: path, version })) ?? prepared;
        } catch {
            // `prepareInstall` reports its own failures; any escape still leaves the DMG to open by hand.
        }
        this.prepared = prepared;
        return prepared;
    }

    isRestartReady(): boolean {
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
     * Inside a recorded GitHub API rate-limit window every check, automatic or user-initiated, skips the API and asks
     * the release page instead (see `LatestReleaseFinder`).
     */
    check(options: { background?: boolean } = {}): Promise<UpdateState> {
        if (this.checkPromise) return this.checkPromise;
        if (this.downloadPromise) return Promise.resolve(this.state);
        // A staged update stays put until the restart or quit that installs it: a visible re-check would replace
        // `ready` and leave a confirmed Restart to Update with nothing to install. Only a silent background look for a
        // newer release may run, and it swaps the staged update only once the newer one is fully staged.
        const isStaged = this.state.status === 'ready' && this.readyPath !== undefined;
        if (isStaged && !options.background) return Promise.resolve(this.state);
        // A download or open failure is still on screen; a silent re-check must not replace it with `available`.
        // A failed check is different: re-checking is how it recovers, so it stays eligible.
        if (options.background && this.state.status === 'error' && this.state.action !== 'check')
            return Promise.resolve(this.state);
        const { acceptanceDiscovery } = this.options;
        if (acceptanceDiscovery && this.acceptanceRelease)
            return Promise.resolve(
                this.state.status === 'available' || this.state.status === 'ready'
                    ? this.state
                    : this.publishAcceptanceRelease(this.acceptanceRelease),
            );
        if (!acceptanceDiscovery && !this.options.enabled)
            return Promise.resolve(
                this.publish({
                    status: 'unavailable',
                    currentVersion: this.options.currentVersion,
                    reason: 'unpackaged',
                }),
            );

        this.lastCheckAttemptAt = this.now();
        if (isStaged && this.release) {
            const supersede = async (staged: AvailableRelease, stagedPath: string) => {
                try {
                    return await this.supersedeReady(staged, stagedPath);
                } finally {
                    this.checkPromise = undefined;
                }
            };
            this.checkPromise = supersede(this.release, this.readyPath!);
            return this.checkPromise;
        }
        // A background re-check stays invisible: publishing `checking` would blank an `available` chip on every tick.
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
        // The fixture has no installer to fetch, so its download completes at once: Acceptance sees the notification a
        // real background download raises, while opening or installing it stays disabled (no `readyPath`).
        if (this.options.acceptanceDiscovery && this.acceptanceRelease)
            return Promise.resolve(this.publish(this.readyState(this.acceptanceRelease)));
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
     * `updates.install`: restarts into the staged update through the ordinary quit confirmations, or without them for a
     * phone's `remote` restart. Resolves with the unchanged state on a cancel; a confirmed restart exits Main first.
     */
    async install(restart?: { remote?: boolean }): Promise<UpdateState> {
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
        if (this.state.status === 'ready' && this.state.resetsData) {
            if (!(await this.options.confirmDataReset?.(release.version))) return this.state;
            this.dataResetConfirmedFor = release.version;
        }
        await this.options.restartToUpdate(restart);
        // Resolving means the restart was cancelled; a later ordinary quit must ask again.
        this.dataResetConfirmedFor = undefined;
        return this.state;
    }

    /**
     * Called by the quit flow once Server Core has stopped and Main is about to exit. Starts the in-place install when
     * a staged update is waiting, so an ordinary quit installs it too and the next launch is the new version. An update
     * that resets data installs only after the user confirmed that version through `install()`. Resolves `false` when
     * there was nothing to install.
     */
    async applyOnExit(options: { relaunch: boolean }): Promise<boolean> {
        const release = this.release;
        if (!release || !this.isRestartReady()) return false;
        if (this.prepared.resetsData && this.dataResetConfirmedFor !== release.version)
            return false;
        await this.options.launchInstall!({ relaunch: options.relaunch, version: release.version });
        return true;
    }
}
