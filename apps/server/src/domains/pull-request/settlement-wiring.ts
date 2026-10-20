import type { SessionActivityTransition } from '../agents';
import { SessionTurnWindows } from '../session';
import type { PullRequestSettlement } from './settlement';

/**
 * Carries Session activity changes to the pull request settlement. The activity hook is installed while the Agent
 * runtime is built, long before the Status services that own the settlement exist, so the composition root creates this
 * holder first and `createServiceHandlers` attaches the settlement to it.
 */
export class PullRequestSettlementWiring {
    private settlement?: PullRequestSettlement;
    readonly turnWindows = new SessionTurnWindows();

    /**
     * @param onActivity Runs first for every transition; the Agent Commander's existing activity hook.
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

    dispose(): void {
        this.settlement?.dispose();
    }
}
