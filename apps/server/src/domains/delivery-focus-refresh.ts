import { randomUUID } from 'node:crypto';

import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import { rememberBounded } from '@caxri/utils';

import type { ProjectStatusService, SessionPullRequestService } from './project-status';

/**
 * Minimum gap between two focus refreshes of one Session. Switching back and forth between apps fires `focus` far more
 * often than delivery state changes, and each accepted refresh spends the same `gh`/`vc` queries as the Status panel's
 * manual refresh against a budget shared with the user's own shell.
 */
export const DELIVERY_FOCUS_REFRESH_MIN_INTERVAL_MS = 15_000;
const MAX_TRACKED_SESSIONS = 128;

export interface DeliveryFocusRefreshOptions {
    logger: StructuredLogger;
    now?: () => number;
    projectStatus: Pick<ProjectStatusService, 'summary'>;
    sessionPullRequests: Pick<SessionPullRequestService, 'refreshSession'>;
}

/**
 * Re-reads the selected Session's delivery status when the window regains focus.
 *
 * The Renderer already refetches its delivery queries on focus, but those reads land on Server caches that hold a
 * settled pull request for minutes, so a PR merged in the browser kept showing as open after the user came back. This
 * bypasses those caches for the one Session the user is looking at, at most once per
 * {@link DELIVERY_FOCUS_REFRESH_MIN_INTERVAL_MS}.
 *
 * The Status panel is forced first because it refetches the pull request with `maxAgeMs: 0`; the sidebar sweep that
 * follows then accepts that just-fetched shared record instead of spending a second query on the same pull request.
 */
export class DeliveryFocusRefresh {
    private readonly lastRefreshAt = new Map<string, number>();
    private readonly now: () => number;

    constructor(private readonly options: DeliveryFocusRefreshOptions) {
        this.now = options.now ?? Date.now;
    }

    private async run(sessionId: string): Promise<void> {
        const startedAt = performance.now();
        let result: 'failed' | 'refreshed' = 'refreshed';
        // Each service logs its own failure cause; a Status panel failure must not keep the sidebar stale too.
        try {
            await this.options.projectStatus.summary(sessionId, randomUUID());
        } catch {
            result = 'failed';
        }
        try {
            await this.options.sessionPullRequests.refreshSession(sessionId);
        } catch {
            result = 'failed';
        }
        this.options.logger.write(
            result === 'failed' ? 'warn' : 'info',
            logEventCatalog.sessionPullRequests.focusRefresh,
            { durationMs: performance.now() - startedAt, fields: { result } },
        );
    }

    /**
     * Starts a refresh unless this Session was refreshed too recently. Returns the running refresh, or `undefined` when
     * throttled; the handler does not wait for it because the change events already carry the result.
     */
    request(sessionId: string): Promise<void> | undefined {
        const now = this.now();
        const last = this.lastRefreshAt.get(sessionId);
        if (last !== undefined && now - last < DELIVERY_FOCUS_REFRESH_MIN_INTERVAL_MS) {
            this.options.logger.write('debug', logEventCatalog.sessionPullRequests.focusRefresh, {
                fields: { result: 'throttled' },
            });
            return undefined;
        }
        rememberBounded(this.lastRefreshAt, sessionId, now, MAX_TRACKED_SESSIONS);
        return this.run(sessionId);
    }
}
