import type { AgentProvider, UsageLimit, UsageResetCredits } from '@caxri/protocol';

import { ResetCreditRefresh } from './reset-credit-refresh';

/**
 * Providers whose plan limits come from asking the running process, because their transcript records none. Codex writes
 * its windows into the rollout, which the live scan already reads; it is asked only for its banked resets
 * ({@link ResetCreditRefresh}), which the rollout lacks.
 */
const ASKED_PROVIDERS: ReadonlySet<AgentProvider> = new Set(['claude']);

/**
 * Keeps the status bar's plan-limit reading for a provider like Claude Code current while one of its Chats is in view.
 * Each live usage read asks the Chat, never twice at once, and never waits: the reading reaches the next poll through
 * `observe`, which hears only a reading newer than the last. The Chat session owns how often it actually asks its
 * process and keeps the reading current from the turn's own events in between (see `ClaudePlanLimits`). A Terminal with
 * no running Chat (a PTY Agent, a stopped Chat) answers nothing and is asked again on the next poll, so switching to a
 * Chat shows its plan within one poll.
 */
export class PlanLimitRefresh {
    private readonly observedAt = new Map<AgentProvider, number>();
    private readonly pending = new Set<AgentProvider>();
    private readonly resetCredits: ResetCreditRefresh;

    constructor(
        private readonly read:
            ((terminalId: string) => Promise<Omit<UsageLimit, 'provider'> | undefined>) | undefined,
        private readonly observer: {
            observeLimits(limits: UsageLimit[]): void;
            observeResetCredits(
                provider: AgentProvider,
                credits: UsageResetCredits | undefined,
            ): void;
        },
        now: () => number = Date.now,
    ) {
        this.resetCredits = new ResetCreditRefresh(read, observer, now);
    }

    private async ask(
        read: NonNullable<PlanLimitRefresh['read']>,
        provider: AgentProvider,
        terminalId: string,
    ): Promise<void> {
        try {
            const limit = await read(terminalId);
            if (!limit || limit.observedAt <= (this.observedAt.get(provider) ?? 0)) return;
            this.observedAt.set(provider, limit.observedAt);
            this.observer.observeLimits([{ provider, ...limit }]);
        } catch {
            // A Chat that closed mid-request answers nothing; the next poll asks again.
        } finally {
            this.pending.delete(provider);
        }
    }

    request(provider: AgentProvider, terminalId: string): void {
        this.resetCredits.request(provider, terminalId);
        if (!this.read || !ASKED_PROVIDERS.has(provider) || this.pending.has(provider)) return;
        this.pending.add(provider);
        void this.ask(this.read, provider, terminalId);
    }
}
