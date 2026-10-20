import { CaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { ProjectStatusClock } from './options';

/**
 * Floor and ceiling for the resident poll. The floor keeps a refresh that is still in flight from being re-triggered in
 * a tight loop; the ceiling bounds how long a rate-limit back-off can leave the panel unattended.
 */
const POLL_MIN_DELAY_MS = 15_000;
const POLL_MAX_DELAY_MS = 5 * 60_000;

interface ResidentPollOptions {
    clock: ProjectStatusClock;
    /**
     * When the cached snapshot of a Session goes stale; zero when nothing is cached yet.
     */
    expiresAt: (sessionId: string) => number;
    logger: StructuredLogger;
    refresh: (sessionId: string) => Promise<unknown>;
}

/**
 * Keeps the delivery status of the visible Sessions warm in the background. Only those Sessions are polled: they are
 * the ones a Status panel can render, and every extra repository costs another `gh`/`vc` round trip against a budget
 * shared with the user's own shell.
 */
export class ResidentPoll {
    private sessionIds: ReadonlySet<string> = new Set();
    private timer?: NodeJS.Timeout;
    private isRunning = false;

    constructor(private readonly options: ResidentPollOptions) {}

    private cancelTimer(): void {
        if (!this.timer) return;
        this.options.clock.clearTimer(this.timer);
        this.timer = undefined;
    }

    private async run(): Promise<void> {
        if (this.isRunning || this.sessionIds.size === 0) return;
        this.isRunning = true;
        try {
            // One Session at a time keeps the `gh`/`vc` budget flat.
            for (const sessionId of this.sessionIds)
                // eslint-disable-next-line no-await-in-loop -- sequential by design, see above
                await this.pollSession(sessionId);
        } finally {
            this.isRunning = false;
            this.schedule();
        }
    }

    private async pollSession(sessionId: string): Promise<void> {
        const startedAt = performance.now();
        let failure: { code: string } | undefined;
        try {
            await this.options.refresh(sessionId);
        } catch (error) {
            failure = { code: error instanceof CaxriError ? error.code : 'INTERNAL' };
        }
        this.options.logger.write('debug', logEventCatalog.projectStatus.poll, {
            durationMs: performance.now() - startedAt,
            fields: failure ? { result: 'failure', ...failure } : { result: 'success' },
        });
    }

    /**
     * The Sessions currently kept warm.
     */
    get polled(): ReadonlySet<string> {
        return this.sessionIds;
    }

    set(sessionIds: ReadonlySet<string>): void {
        const current = this.sessionIds;
        if (sessionIds.size === current.size && [...sessionIds].every((id) => current.has(id)))
            return;
        this.sessionIds = new Set(sessionIds);
        this.schedule();
    }

    /**
     * A deleted Session must not keep a background `gh`/`vc` refresh alive on its behalf.
     */
    remove(sessionId: string): void {
        if (this.sessionIds.has(sessionId))
            this.set(new Set([...this.sessionIds].filter((id) => id !== sessionId)));
    }

    /**
     * Arms the next refresh against the soonest cache expiry among the polled Sessions, so a snapshot with a running
     * job is revisited sooner than a settled one and a rate-limited source is left alone.
     */
    schedule(): void {
        const { clock, expiresAt } = this.options;
        this.cancelTimer();
        if (this.sessionIds.size === 0) return;
        const soonest = Math.min(...[...this.sessionIds].map((sessionId) => expiresAt(sessionId)));
        const delayMs = Math.min(
            Math.max(soonest - clock.now(), POLL_MIN_DELAY_MS),
            POLL_MAX_DELAY_MS,
        );
        const timer = clock.setTimer(() => {
            this.timer = undefined;
            // Fire-and-forget: `run` owns its own failure logging and re-arms the timer either way.
            // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
            void this.run();
        }, delayMs);
        // Never hold the Server process open for a background refresh.
        timer.unref();
        this.timer = timer;
    }

    /**
     * Stops polling; called when the Server shuts down.
     */
    dispose(): void {
        this.sessionIds = new Set();
        this.cancelTimer();
    }
}
