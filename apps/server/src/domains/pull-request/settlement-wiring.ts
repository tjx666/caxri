import type { SessionPullRequest } from '@caxri/protocol';

import type { SessionActivityTransition } from '../agents';
import { SessionTurnWindows } from '../session';
import type { PullRequestSettlement } from './settlement';

/**
 * Carries Session activity changes to the pull request settlement. The activity hook is installed while the Agent
 * runtime is built, long before the Status services that own the settlement exist, so the composition root creates this
 * holder first and `createServiceHandlers` attaches the settlement to it. It also keeps each Session's latest pull
 * request state for consumers built before the Status services, such as Chat idle compaction.
 */
export class PullRequestSettlementWiring {
    private settlement?: PullRequestSettlement;
    private readonly states = new Map<string, SessionPullRequest['state']>();
    readonly turnWindows = new SessionTurnWindows();

    /**
     * @param onActivity Runs first for every transition; Caxri Bot's existing activity hook.
     */
    constructor(private readonly onActivity: (transition: SessionActivityTransition) => void) {}

    attach(settlement: PullRequestSettlement): void {
        this.settlement = settlement;
    }

    observeActivity(transition: SessionActivityTransition): void {
        this.onActivity(transition);
        this.turnWindows.observe(transition);
        this.settlement?.observeActivity(transition);
    }

    /**
     * Receives every pull request change the Session pull request service resolves, including a Session's first one.
     */
    observePullRequest(
        sessionId: string,
        previous: SessionPullRequest | undefined,
        next: SessionPullRequest | undefined,
    ): void {
        if (next) this.states.set(sessionId, next.state);
        else this.states.delete(sessionId);
        this.settlement?.observePullRequest(sessionId, previous, next);
    }

    /**
     * The Session's pull request state as last resolved in this Server Core, without a GitHub lookup.
     */
    pullRequestState(sessionId: string): SessionPullRequest['state'] | undefined {
        return this.states.get(sessionId);
    }

    forgetSession(sessionId: string): void {
        this.states.delete(sessionId);
        this.settlement?.forgetSession(sessionId);
    }

    dispose(): void {
        this.settlement?.dispose();
    }
}
