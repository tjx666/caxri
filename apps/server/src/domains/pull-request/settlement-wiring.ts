import type { SessionPullRequest } from '@caxri/protocol';

import type { SessionActivityTransition } from '../agents';
import type { AutoMarkDone } from '../session';
import { SessionTurnWindows } from '../session';
import type { PullRequestSettlement } from './settlement';

/**
 * Carries Session activity changes to the pull request settlement. The activity hook is installed while the Agent
 * runtime is built, long before the Status services that own the settlement exist, so the composition root creates this
 * holder first and `createServiceHandlers` attaches the settlement to it. It also keeps each Session's latest pull
 * request for consumers built before the Status services, such as Chat idle compaction.
 */
export class PullRequestSettlementWiring {
    private settlement?: PullRequestSettlement;
    private autoMarkDone?: AutoMarkDone;
    private readonly pullRequests = new Map<string, SessionPullRequest>();
    readonly turnWindows = new SessionTurnWindows();

    /**
     * @param onActivity Runs first for every transition; Caxri Bot's existing activity hook.
     */
    constructor(private readonly onActivity: (transition: SessionActivityTransition) => void) {}

    attach(settlement: PullRequestSettlement): void {
        this.settlement = settlement;
    }

    /**
     * Attaches the automatic Mark as Done sweep, which also reacts to a pull request merging or closing and shares this
     * holder's lifetime.
     */
    attachAutoMarkDone(autoMarkDone: AutoMarkDone): void {
        this.autoMarkDone = autoMarkDone;
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
        if (next) this.pullRequests.set(sessionId, next);
        else this.pullRequests.delete(sessionId);
        this.settlement?.observePullRequest(sessionId, previous, next);
        this.autoMarkDone?.observePullRequest(sessionId, next);
    }

    /**
     * The Session's pull request as last resolved in this Server Core, without a GitHub lookup.
     */
    pullRequest(sessionId: string): SessionPullRequest | undefined {
        return this.pullRequests.get(sessionId);
    }

    forgetSession(sessionId: string): void {
        this.pullRequests.delete(sessionId);
        this.settlement?.forgetSession(sessionId);
    }

    dispose(): void {
        this.settlement?.dispose();
        this.autoMarkDone?.dispose();
    }
}
