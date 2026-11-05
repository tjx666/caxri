import { AUTO_HAND_BACK_AFTER_MS } from '@caxri/protocol';

import type { WatchHandle, WatchHub } from '../../watch';
import type { WindowPresence } from '../../window-presence';
import type { AutoHandBackOutcome } from './service';
import { isRetryableAutoRefusal } from './service';

/**
 * How often the left Sessions are checked. A hand-back is due five minutes after the user left, so a half-minute sweep
 * keeps it within a sweep of that.
 */
const AUTO_HAND_BACK_SWEEP_INTERVAL_MS = 30_000;

interface Options {
    /**
     * The hand-back grants, late-bound: the delegation service is composed after the supervision slice that owns this.
     */
    autoHandBack(sessionId: string): AutoHandBackOutcome | undefined;
    /**
     * `agents.delegation.autoHandBack`.
     */
    isEnabled(): boolean;
    /**
     * Whether the user holds the Session now (its feed `control` is `human`).
     */
    isHumanControlled(sessionId: string): boolean;
    /**
     * Whether a phone is watching the Session's Chat, which counts as the user looking at it.
     */
    isObservedRemotely(sessionId: string): boolean;
    presence: Pick<WindowPresence, 'isSettled' | 'onVisibleChange' | 'visibleSessionIds'>;
    watchHub: Pick<WatchHub, 'registerPoller'>;
    now?: () => number;
    sweepIntervalMs?: number;
}

/**
 * Hands a Session the user took over back to the Agent that delegated it once the user has left it alone, so a takeover
 * the user forgot does not stall the delegating Agent's plan. The idea of releasing a take-over after the user leaves
 * comes from Muxy's phone pane take-over (`docs/agent-delegation.md`, Automatic hand-back).
 *
 * The wait starts only when a Session the user holds leaves every visible window during this Server's lifetime, so a
 * Session taken over days ago and never opened since is not handed back the moment this ships or the Server restarts.
 * Returning to the Session, or a phone watching it, cancels the wait; it restarts when they leave again. Once
 * {@link AUTO_HAND_BACK_AFTER_MS} has passed, the hand-back goes through the owner's own guards: a busy child or unsent
 * Terminal text restarts the wait (so the Agent stays idle for the whole wait), and any other refusal ends it.
 */
export class DelegationAutoHandBack {
    /**
     * Session ID to when the current wait started.
     */
    private readonly waiting = new Map<string, number>();
    private visible: ReadonlySet<string> = new Set();
    private poller: WatchHandle | undefined;
    private unsubscribe: (() => void) | undefined;

    constructor(private readonly options: Options) {}

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    private observeVisible(): void {
        const next = this.options.presence.visibleSessionIds();
        for (const sessionId of next) this.waiting.delete(sessionId);
        if (this.options.isEnabled())
            for (const sessionId of this.visible)
                if (!next.has(sessionId) && this.options.isHumanControlled(sessionId))
                    this.waiting.set(sessionId, this.now());
        this.visible = new Set(next);
    }

    start(): void {
        this.visible = new Set(this.options.presence.visibleSessionIds());
        this.unsubscribe = this.options.presence.onVisibleChange(() => this.observeVisible());
        this.poller = this.options.watchHub.registerPoller({
            intervalMs: this.options.sweepIntervalMs ?? AUTO_HAND_BACK_SWEEP_INTERVAL_MS,
            label: 'delegation-auto-hand-back',
            pollOnce: () => this.sweep(),
        });
    }

    async close(): Promise<void> {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        await this.poller?.dispose();
        this.poller = undefined;
        this.waiting.clear();
    }

    /**
     * One pass over the Sessions the user left.
     */
    sweep(): void {
        if (!this.options.isEnabled()) {
            this.waiting.clear();
            return;
        }
        // Before Desktop reports presence, nobody is known to be away.
        if (!this.options.presence.isSettled()) return;
        const now = this.now();
        for (const [sessionId, since] of this.waiting) {
            if (this.options.isObservedRemotely(sessionId)) {
                this.waiting.set(sessionId, now);
                continue;
            }
            if (now - since < AUTO_HAND_BACK_AFTER_MS) continue;
            const outcome = this.options.autoHandBack(sessionId);
            if (outcome === undefined) continue;
            if (outcome !== 'granted' && outcome !== 'duplicate' && isRetryableAutoRefusal(outcome))
                this.waiting.set(sessionId, now);
            else this.waiting.delete(sessionId);
        }
    }

    /**
     * The Sessions waiting to be handed back, for tests.
     */
    waitingSessionIds(): string[] {
        return this.waiting.keys().toArray();
    }
}
