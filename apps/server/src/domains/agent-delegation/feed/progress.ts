import type { AgentDelegationProgress } from '@caxri/protocol';

/**
 * Shortest time between two `agent.delegation.progress` events of one task. A Chat patches many times a second while it
 * streams, and the Delegated Sessions feed shows one short label per Session.
 */
export const DELEGATION_PROGRESS_INTERVAL_MS = 1000;

interface TrackedStep {
    sessionId: string;
    /**
     * The newest step observed.
     */
    latest?: string;
    /**
     * The step the last emitted event carried, so a step that did not change emits nothing.
     */
    emitted?: string;
    lastEmittedAt: number;
    timer?: NodeJS.Timeout;
}

/**
 * Turns the steps an active Chat Session reports into throttled `agent.delegation.progress` events: the first change
 * emits at once, later changes within {@link DELEGATION_PROGRESS_INTERVAL_MS} collapse into one trailing event carrying
 * the newest step, and a step equal to the last emitted one emits nothing. A task that settles is dropped without a
 * closing event; the Client already learns it settled from the receipt change and discards the step.
 *
 * The step is private domain data: this class neither logs it nor keeps it past the task.
 */
export class DelegationProgress {
    private readonly tracked = new Map<string, TrackedStep>();

    constructor(
        private readonly emit: (progress: AgentDelegationProgress) => void,
        private readonly now: () => number,
    ) {}

    private flush(delegationId: string, state: TrackedStep): void {
        if (this.tracked.get(delegationId) !== state || state.latest === state.emitted) return;
        state.emitted = state.latest;
        state.lastEmittedAt = this.now();
        this.emit({
            sessionId: state.sessionId,
            delegationId,
            ...(state.latest !== undefined && { step: state.latest }),
        });
    }

    /**
     * Starts following an active task. Idempotent: a task already followed keeps its state.
     */
    track(delegationId: string, sessionId: string): void {
        if (!this.tracked.has(delegationId))
            this.tracked.set(delegationId, { sessionId, lastEmittedAt: -Infinity });
    }

    /**
     * Reports the step a followed task is on now (`undefined` while it has none). A task that is not followed is
     * ignored.
     */
    observe(delegationId: string, step: string | undefined): void {
        const state = this.tracked.get(delegationId);
        if (!state) return;
        state.latest = step;
        if (state.timer) return;
        if (step === state.emitted) return;
        const wait = DELEGATION_PROGRESS_INTERVAL_MS - (this.now() - state.lastEmittedAt);
        if (wait <= 0) {
            this.flush(delegationId, state);
            return;
        }
        state.timer = setTimeout(() => {
            state.timer = undefined;
            this.flush(delegationId, state);
        }, wait);
        state.timer.unref();
    }

    /**
     * Stops following a task that settled and drops its pending event.
     */
    settle(delegationId: string): void {
        const state = this.tracked.get(delegationId);
        if (!state) return;
        if (state.timer) clearTimeout(state.timer);
        this.tracked.delete(delegationId);
    }

    close(): void {
        for (const state of this.tracked.values()) if (state.timer) clearTimeout(state.timer);
        this.tracked.clear();
    }
}
