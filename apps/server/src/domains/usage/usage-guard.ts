import type { AgentChatHandoff, AgentProvider, AgentUsageGuard, UsageLimit } from '@caxri/protocol';
import { agentProviderCatalog, CaxriError, weeklyUsageGuardWindow } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import { notifyListeners } from '@caxri/utils';

import type { AppStateValue, CaxriDatabase } from '../db';

type StoredGuard = AppStateValue<'agentUsageGuards'>[number];

/**
 * The ordinary model requests the guard refuses, for the log. Closed so refusals can be counted per path without text.
 */
export type UsageGuardPath =
    | 'chat_send'
    | 'chat_command'
    | 'chat_queue'
    | 'chat_side_question'
    | 'idle_compaction'
    | 'delegation'
    | 'dispatch'
    | 'auto_naming';

type GuardOutcome =
    | 'armed'
    | 'window_reset'
    | 'refused'
    | 'handoff_started'
    | 'handoff_generated'
    | 'handoff_failed';

/**
 * Two readings of one weekly window can disagree on its reset by seconds (a transcript and `/usage` round differently);
 * a reset further apart than this is another window.
 */
const SAME_WINDOW_TOLERANCE_MS = 60 * 60_000;

/**
 * `setTimeout` clamps a longer delay to 1 ms; a weekly window is shorter, but a corrupt reset must not spin.
 */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * The weekly usage guard of each provider account (issue #2580). Once the provider's raw weekly figure reaches
 * `AGENT_USAGE_GUARD_PERCENT`, every ordinary model request for that account is refused until the window's `resetsAt`,
 * keeping the last percent for one hand-off. The guard is sticky for its window: a later, lower reading of the same
 * window does not lift it (the remaining budget is what it protects); a reading of a later window, or reaching
 * `resetsAt`, does.
 *
 * The account is the provider for now: Caxri runs one sign-in per provider, and per-account isolation follows once
 * accounts are told apart. Persisted in `app_state` so a restart neither lifts the guard early nor grants a second
 * hand-off in the same window.
 */
export class AgentUsageGuards {
    private readonly guards = new Map<AgentProvider, StoredGuard>();
    private readonly listeners = new Set<(provider: AgentProvider) => void>();
    private timer: ReturnType<typeof setTimeout> | undefined;

    constructor(
        private readonly options: {
            database: Pick<CaxriDatabase, 'getAppState' | 'setAppState'>;
            logger: StructuredLogger;
            now?: () => number;
        },
    ) {
        for (const guard of this.load()) this.guards.set(guard.provider, guard);
        this.expire();
    }

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    private load(): StoredGuard[] {
        try {
            return this.options.database.getAppState('agentUsageGuards') ?? [];
        } catch {
            // A record this build cannot read is dropped: the next reading arms the guard again.
            return [];
        }
    }

    private save(): void {
        this.options.database.setAppState('agentUsageGuards', this.guards.values().toArray());
    }

    private log(
        provider: AgentProvider,
        outcome: GuardOutcome,
        fields: Record<string, string | number | null> = {},
    ): void {
        this.options.logger.write(
            outcome === 'refused' || outcome === 'handoff_failed' ? 'warn' : 'info',
            logEventCatalog.usage.guard,
            { fields: { provider, outcome, ...fields } },
        );
    }

    private changed(provider: AgentProvider): void {
        this.save();
        this.schedule();
        notifyListeners(this.listeners, provider);
    }

    /**
     * Lifts every guard whose window has reset.
     */
    private expire(): void {
        const now = this.now();
        for (const [provider, guard] of this.guards) {
            if (guard.resetsAt > now) continue;
            this.guards.delete(provider);
            this.log(provider, 'window_reset', { durationMs: now - guard.armedAt });
            this.changed(provider);
        }
        this.schedule();
    }

    private schedule(): void {
        clearTimeout(this.timer);
        this.timer = undefined;
        const resets = this.guards.values().map((guard) => guard.resetsAt);
        const next = Math.min(...resets);
        if (!Number.isFinite(next)) return;
        const delay = Math.max(0, next - this.now());
        this.timer = setTimeout(() => this.expire(), Math.min(MAX_TIMER_MS, delay));
        this.timer.unref();
    }

    /**
     * One reading of the provider's plan windows, from any source: a transcript, `/usage`, or a live rate-limit event.
     * A reading without a weekly window says nothing about the guard.
     */
    observe(provider: AgentProvider, limit: Pick<UsageLimit, 'windows'>): void {
        const now = this.now();
        const existing = this.current(provider);
        const window = weeklyUsageGuardWindow(limit, now);
        if (window) {
            if (
                existing &&
                Math.abs(existing.resetsAt - window.resetsAt) < SAME_WINDOW_TOLERANCE_MS
            )
                return;
            this.guards.set(provider, { provider, ...window, armedAt: now, handoff: 'available' });
            this.log(provider, 'armed', { usedPercent: Math.floor(window.usedPercent) });
            this.changed(provider);
            return;
        }
        const weekly = limit.windows.find((candidate) => candidate.scope === 'weekly');
        if (
            !existing ||
            !weekly?.resetsAt ||
            weekly.resetsAt <= existing.resetsAt + SAME_WINDOW_TOLERANCE_MS
        )
            return;
        // A later window below the guard: the account's week reset before the time the guard recorded.
        const armedAt = this.guards.get(provider)?.armedAt ?? now;
        this.guards.delete(provider);
        this.log(provider, 'window_reset', { durationMs: now - armedAt });
        this.changed(provider);
    }

    current(provider: AgentProvider): AgentUsageGuard | undefined {
        const guard = this.guards.get(provider);
        if (!guard || guard.resetsAt <= this.now()) return undefined;
        const { usedPercent, resetsAt, handoff } = guard;
        return { provider, usedPercent, resetsAt, handoff };
    }

    /**
     * The hand-off document a Chat produced on this window's lease, if it is the Chat that spent it.
     */
    document(provider: AgentProvider, terminalId: string): AgentChatHandoff | undefined {
        const guard = this.guards.get(provider);
        return guard?.handoffTerminalId === terminalId ? guard.document : undefined;
    }

    /**
     * Refuses an ordinary model request while the provider's account is at the guard, with `USAGE_LIMITED` and the
     * reset time, so every Client and CLI caller can say when it lifts.
     */
    assertAdmitted(provider: AgentProvider, path: UsageGuardPath): void {
        const guard = this.current(provider);
        if (!guard) return;
        this.log(provider, 'refused', { path });
        throw new CaxriError(
            'USAGE_LIMITED',
            `${agentProviderCatalog[provider].displayName} weekly usage is at ${Math.floor(guard.usedPercent)}%; new requests are paused until the weekly limit resets`,
            { provider, resetsAt: guard.resetsAt },
        );
    }

    subscribe(listener: (provider: AgentProvider) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /**
     * Spends the window's one hand-off lease for this Chat. Fails with `CONFLICT` once any Chat of the account spent
     * it, and when no guard is armed: a hand-off is only for a blocked Chat.
     */
    claimHandoff(provider: AgentProvider, terminalId: string): void {
        const guard = this.guards.get(provider);
        if (!guard || !this.current(provider))
            throw new CaxriError('CONFLICT', 'Usage is not at the weekly guard');
        if (guard.handoff !== 'available')
            throw new CaxriError(
                'CONFLICT',
                'The hand-off for this weekly window was already generated',
            );
        this.guards.set(provider, {
            ...guard,
            handoff: 'generating',
            handoffTerminalId: terminalId,
            document: { status: 'generating', startedAt: this.now() },
        });
        this.log(provider, 'handoff_started');
        this.changed(provider);
    }

    /**
     * Records what the lease produced. The lease stays spent whatever the outcome: the budget it protected is gone.
     */
    settleHandoff(provider: AgentProvider, terminalId: string, document: AgentChatHandoff): void {
        const guard = this.guards.get(provider);
        if (guard?.handoffTerminalId !== terminalId) return;
        this.guards.set(provider, { ...guard, handoff: 'used', document });
        if (document.status === 'failed')
            this.log(provider, 'handoff_failed', { reason: document.reason });
        else this.log(provider, 'handoff_generated');
        this.changed(provider);
    }

    close(): void {
        clearTimeout(this.timer);
        this.listeners.clear();
    }
}
