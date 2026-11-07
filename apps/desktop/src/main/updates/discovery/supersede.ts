import { compareStableVersions } from '@caxri/protocol';

import type { AvailableRelease } from '../update-download';
import { downloadVerifiedUpdate } from '../update-download';
import { isRateLimitedStatus, rateLimitResumeAt } from '../update-github-release';
import type { PreparedInstall, UpdateFetch } from '../update-service-contract';

/**
 * What {@link supersedeStagedUpdate} needs from the service that owns the staged update. Everything the service keeps as
 * private state is reached through these fields and callbacks so the swap stays in one place.
 */
export interface SupersedeDependencies {
    currentVersion: string;
    downloadDirectory: string;
    /**
     * The newer version a previous silent supersede already failed on in this process.
     */
    failedVersion: string | undefined;
    fetch: UpdateFetch;
    now: () => number;
    /**
     * Stages (or restages) a bundle through the host's `prepareInstall`.
     */
    prepareInstall: (input: {
        dmgPath: string;
        version: string;
    }) => Promise<PreparedInstall> | undefined;
    /**
     * How the already staged installer installs; a newer bundle that cannot restart-install must not replace it.
     */
    previous: PreparedInstall;
    /**
     * Validates a successful `releases/latest` answer and returns the newer release, or `undefined` when there is none.
     */
    readLatest: (response: Response) => Promise<AvailableRelease | undefined>;
    /**
     * Records the rate-limit reset GitHub reported for the silent look.
     */
    recordRateLimit: (until: number | undefined) => void;
    /**
     * Fetches `releases/latest`.
     */
    requestLatest: () => Promise<Response>;
    staged: AvailableRelease;
    stagedPath: string;
}

/**
 * The outcome of a silent supersede: keep offering the staged update, or swap to the newer fully staged one.
 */
export type SupersedeResult =
    | { failedVersion: string | undefined; kind: 'keep' }
    | { kind: 'swap'; path: string; prepared: PreparedInstall; release: AvailableRelease };

/**
 * Looks for a release newer than the staged one and, when there is one, downloads and stages it without publishing
 * anything. A rate limit, a failed request, or a failed download resolves to `keep`.
 *
 * Staging the newer bundle empties the shared staging directory, so a newer bundle that fails to stage restages the old
 * one before giving up. The few seconds in between are the only window where a quit installs nothing.
 */
export async function supersedeStagedUpdate(
    dependencies: SupersedeDependencies,
): Promise<SupersedeResult> {
    let failedVersion = dependencies.failedVersion;
    const keep = (): SupersedeResult => ({ kind: 'keep', failedVersion });
    try {
        const response = await dependencies.requestLatest();
        if (isRateLimitedStatus(response.status)) {
            dependencies.recordRateLimit(rateLimitResumeAt(response, dependencies.now()));
            return keep();
        }
        if (response.status === 404) return keep();
        const newer = await dependencies.readLatest(response);
        if (!newer || compareStableVersions(newer.version, dependencies.staged.version) <= 0)
            return keep();
        if (newer.version === failedVersion) return keep();
        failedVersion = newer.version;

        let newPath: string | undefined;
        let newPrepared: PreparedInstall = { installMode: 'manual' };
        const result = await downloadVerifiedUpdate(
            {
                currentVersion: dependencies.currentVersion,
                downloadDirectory: dependencies.downloadDirectory,
                fetch: dependencies.fetch,
                keepFileNames: [dependencies.staged.fileName],
                now: dependencies.now,
                prepareReady: async (path) => {
                    newPath = path;
                    try {
                        newPrepared =
                            (await dependencies.prepareInstall({
                                dmgPath: path,
                                version: newer.version,
                            })) ?? newPrepared;
                    } catch {
                        // Same contract as `prepareReady`: an escape leaves the DMG to open by hand.
                    }
                    return newPrepared;
                },
                // The newer download is silent: only the swap publishes.
                publish: (state) => state,
            },
            newer,
            new AbortController().signal,
        );
        if (newPath === undefined || result.status !== 'ready') return keep();
        if (
            newPrepared.installMode !== 'restart' &&
            dependencies.previous.installMode === 'restart'
        ) {
            // Staging the newer bundle emptied the shared directory: put the old one back and keep offering it.
            await dependencies.prepareInstall({
                dmgPath: dependencies.stagedPath,
                version: dependencies.staged.version,
            });
            return keep();
        }
        return { kind: 'swap', release: newer, path: newPath, prepared: newPrepared };
    } catch {
        return keep();
    }
}
