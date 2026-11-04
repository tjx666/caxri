/**
 * How many retired launch IDs are remembered to judge a request made after its delegating Agent's launch ended.
 */
const MAX_REMEMBERED_RETIREMENTS = 256;

interface PresenceHost {
    hasTerminal(terminalId: string): boolean;
    currentLaunchId?(terminalId: string): string | undefined;
}

/**
 * Whether a delegating Agent's original launch is definitively gone, shared by the questions and approvals a delegated
 * Agent directs at it. Gone means its Terminal was deleted, its launch was seen retiring, or a different launch is live
 * in its Terminal. A launch that is only starting or suspending, or has no ID yet, is not gone: the grace period covers
 * it. In memory on purpose: every open question and pending approval ends when Server Core restarts.
 */
export class ParentPresence {
    private readonly retired = new Set<string>();

    constructor(private readonly host: PresenceHost) {}

    /**
     * A launch retired for good (a Host-side retirement, not a person typing).
     */
    retire(launchId: string): void {
        this.retired.add(launchId);
        if (this.retired.size > MAX_REMEMBERED_RETIREMENTS)
            this.retired.delete(this.retired.values().next().value!);
    }

    isGone(terminalId: string | undefined, launchId: string | undefined): boolean {
        if (!terminalId) return false;
        if (!this.host.hasTerminal(terminalId)) return true;
        if (!launchId) return false;
        if (this.retired.has(launchId)) return true;
        const live = this.host.currentLaunchId?.(terminalId);
        return live !== undefined && live !== launchId;
    }
}
