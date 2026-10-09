import type { AppSettings } from '@caxri/protocol';
import { WebglAddon } from '@xterm/addon-webgl';
import type { IDisposable, ITerminalAddon } from '@xterm/xterm';

import type { TerminalWebglSessionPolicy } from './terminal-webgl-session-policy';

export type TerminalGpuAcceleration = AppSettings['terminal.gpuAcceleration'];
export type TerminalRendererMode = 'dom' | 'webgl';
export type TerminalRendererRedrawIntent = 'content-only' | 'grid-sync';
export type TerminalRendererReason =
    | 'active'
    | 'context-loss'
    | 'context-loss-limit'
    | 'disabled'
    | 'disposed'
    | 'load-failed'
    /**
     * The pane belongs to a Session kept alive off screen, so its WebGL context was released deliberately. Never
     * conflate it with `context-loss`: the GPU incident budget only stays meaningful if a released context and a lost
     * one are different events.
     */
    | 'suspended'
    | 'unsupported';
export type TerminalRendererRetryState =
    | 'cancelled'
    | 'deferred'
    | 'exhausted'
    | 'failed'
    | 'idle'
    | 'scheduled'
    | 'succeeded'
    | 'trying';
export type TerminalRendererTrigger =
    | 'atlas-clear-failed'
    | 'dispose'
    | 'gpu-incident-limit'
    | 'gpu-process-recovery'
    | 'keep-alive-resume'
    | 'keep-alive-suspend'
    | 'manual-retry'
    | 'preference-change'
    | 'visibility-restore'
    | 'webgl-context-loss'
    | 'webgl-load-failed'
    | 'webgl-reprobe-succeeded'
    | 'webgl-retry-attempt'
    | 'webgl-retry-cancelled'
    | 'webgl-retry-deferred'
    | 'webgl-retry-exhausted'
    | 'webgl-retry-failed'
    | 'webgl-retry-scheduled'
    | 'webgl-retry-succeeded';

const TERMINAL_WEBGL_RETRY_BASE_DELAY_MS = 1_000;
/**
 * Upper bound shared with the `retryDelayMs` diagnostic schema; a larger value would drop the whole diagnostic.
 */
const TERMINAL_WEBGL_RETRY_MAX_DELAY_MS = 60_000;
const TERMINAL_WEBGL_RETRY_LIMIT = 3;
const TERMINAL_WEBGL_RETRY_WINDOW_MS = 60_000;

export interface TerminalRendererStatus {
    contextLossCount: number;
    /**
     * Terminal WebGL contexts live in this Renderer when the status was published; on a loss it is sampled before the
     * lost context is released, so it includes the lost one. See `TerminalWebglSessionPolicy.liveWebglContextCount`.
     */
    liveWebglContextCount: number;
    mode: TerminalRendererMode;
    reason: TerminalRendererReason;
    redrawCount: number;
    recoveryResult: 'not-requested' | 'already-dom' | 'dom-restored' | 'failed';
    retryAttemptCount: number;
    retryDelayMs: number | null;
    retryLimit: typeof TERMINAL_WEBGL_RETRY_LIMIT;
    retrySequenceId?: string;
    retryState: TerminalRendererRetryState;
    trigger: TerminalRendererTrigger;
}

interface WebglRendererAddon extends ITerminalAddon {
    clearTextureAtlas(): void;
    onContextLoss(listener: () => void): IDisposable;
}

interface TerminalRendererHost {
    loadAddon(addon: ITerminalAddon): void;
}

type WebglAddonFactory = () => WebglRendererAddon;

export interface TerminalRendererControllerOptions {
    /**
     * Brackets one WebGL activation. Injected rather than imported so this controller stays a pure unit, and so the
     * Session-switch receipt can tell GPU attach cost apart from the Renderer cost of building xterm.
     */
    beginActivationMeasurement?: () => () => void;
    canRetryWebgl?: () => boolean;
    createRetrySequenceId?: () => string;
    createWebglAddon?: WebglAddonFactory;
    now?: () => number;
    /**
     * Required: every pane must answer to the session budget, so no call site can silently fall back to a policy that
     * never pins.
     */
    policy: TerminalWebglSessionPolicy;
    /**
     * Unit interval source for retry jitter; injected so tests can pin the delay.
     */
    random?: () => number;
}

/**
 * Exponential backoff with full ±50% jitter so N panes that lost the same GPU context do not rebuild their WebGL
 * contexts in the same instant. Attempts 0..2 land in 0.5–1.5 s, 1–3 s, and 2–6 s; the cap keeps the value inside the
 * diagnostic schema bound.
 */
export function terminalWebglRetryDelayMs(attemptIndex: number, random: () => number): number {
    const exponential = TERMINAL_WEBGL_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attemptIndex);
    const jittered = exponential * (0.5 + Math.min(Math.max(random(), 0), 1));
    return Math.min(Math.round(jittered), TERMINAL_WEBGL_RETRY_MAX_DELAY_MS);
}

export function resolveTerminalRendererTarget(
    preference: TerminalGpuAcceleration,
    isWebgl2Available: boolean,
): TerminalRendererMode {
    if (preference === 'off' || !isWebgl2Available) return 'dom';
    return 'webgl';
}

/**
 * Owns the replaceable xterm renderer only. Falling back disposes WebGL and asks xterm to redraw; it never touches the
 * Server, PTY, buffer, or Agent lifecycle.
 */
export class TerminalRendererController {
    private contextLossCount = 0;
    private disposed = false;
    /**
     * Whether `webgl` was counted by the session policy; a load that threw before xterm activated it never was.
     */
    private isWebglContextCounted = false;
    private lossDisposable: IDisposable | undefined;
    private preference: TerminalGpuAcceleration | undefined;
    private redrawCount = 0;
    private readonly retryAttemptTimestamps: number[] = [];
    private retryDelayMs: number | null = null;
    private retryReason:
        Extract<TerminalRendererReason, 'context-loss' | 'load-failed'> | undefined;
    private retrySequenceId: string | undefined;
    private retryState: TerminalRendererRetryState = 'idle';
    private retryTimer: ReturnType<typeof setTimeout> | undefined;
    private status: TerminalRendererStatus | undefined;
    private suspended = false;
    private webgl: WebglRendererAddon | undefined;
    /**
     * Live-context count captured at the start of a loss transition, before the lost context is released, so every
     * record that transition publishes reports the pressure that existed when the context was lost.
     */
    private webglContextCountAtLoss: number | undefined;

    private readonly beginActivationMeasurement: () => () => void;
    private readonly canRetryWebgl: () => boolean;
    private readonly createRetrySequenceId: () => string;
    private readonly createWebglAddon: WebglAddonFactory;
    private readonly now: () => number;
    private readonly policy: TerminalWebglSessionPolicy;
    private readonly random: () => number;

    constructor(
        private readonly host: TerminalRendererHost,
        private readonly redraw: (intent: TerminalRendererRedrawIntent) => void,
        private readonly onStatus: (status: TerminalRendererStatus) => void,
        options: TerminalRendererControllerOptions,
    ) {
        this.beginActivationMeasurement = options.beginActivationMeasurement ?? (() => () => {});
        this.canRetryWebgl =
            options.canRetryWebgl ?? (() => document.visibilityState === 'visible');
        this.createRetrySequenceId = options.createRetrySequenceId ?? (() => crypto.randomUUID());
        this.createWebglAddon = options.createWebglAddon ?? (() => new WebglAddon());
        this.now = options.now ?? (() => Date.now());
        this.policy = options.policy;
        this.random = options.random ?? Math.random;
    }

    private handleContextLoss(): void {
        if (!this.webgl) return;
        this.webglContextCountAtLoss = this.policy.liveWebglContextCount();
        try {
            this.recordContextLoss();
            this.fallback('context-loss', 'webgl-context-loss');
        } finally {
            this.webglContextCountAtLoss = undefined;
        }
    }

    private recordContextLoss(): void {
        this.contextLossCount += 1;
        this.policy.recordContextLoss();
    }

    private fallback(
        reason: Extract<TerminalRendererReason, 'context-loss' | 'load-failed'>,
        trigger: Extract<TerminalRendererTrigger, 'atlas-clear-failed' | 'webgl-context-loss'>,
    ): void {
        this.disposeWebgl();
        this.redrawTerminal('grid-sync');
        this.beginRetry(reason);
        // The budget may have pinned on this very loss (xterm's context-loss event can precede Main's incident); the
        // pane then settles on the closed reason here instead of waiting for a recovery call that may never re-publish.
        this.publish(
            this.preference !== 'off' && this.policy.isPinnedToDom()
                ? 'context-loss-limit'
                : reason,
            trigger,
        );
    }

    private activateWebgl(
        successTrigger: Extract<
            TerminalRendererTrigger,
            'preference-change' | 'webgl-reprobe-succeeded' | 'webgl-retry-succeeded'
        >,
        failureTrigger: Extract<
            TerminalRendererTrigger,
            'webgl-load-failed' | 'webgl-retry-failed'
        >,
    ): boolean {
        let addon: WebglRendererAddon | undefined;
        const settleMeasurement = this.beginActivationMeasurement();
        try {
            addon = this.createWebglAddon();
            this.webgl = addon;
            this.lossDisposable = addon.onContextLoss(() => this.handleContextLoss());
            this.host.loadAddon(addon);
            this.isWebglContextCounted = true;
            this.policy.recordWebglContextAcquired();
            settleMeasurement();
            this.redrawTerminal('grid-sync');
            if (successTrigger === 'webgl-retry-succeeded') this.retryState = 'succeeded';
            this.retryDelayMs = null;
            this.publish('active', successTrigger);
            if (successTrigger === 'webgl-retry-succeeded') {
                this.retryReason = undefined;
                this.retrySequenceId = undefined;
                this.retryState = 'idle';
            }
            return true;
        } catch {
            settleMeasurement();
            this.lossDisposable?.dispose();
            this.lossDisposable = undefined;
            if (this.webgl === addon) this.webgl = undefined;
            this.releaseWebglContextCount();
            try {
                addon?.dispose();
            } catch {
                // A partially activated addon must still fail closed to xterm's DOM renderer.
            }
            this.redrawTerminal('grid-sync');
            if (failureTrigger === 'webgl-retry-failed') {
                this.retryReason = 'load-failed';
                this.retryState = 'failed';
            }
            this.retryDelayMs = null;
            this.publish('load-failed', failureTrigger);
            return false;
        }
    }

    private beginRetry(
        reason: Extract<TerminalRendererReason, 'context-loss' | 'load-failed'>,
    ): void {
        if (this.preference === 'off' || this.disposed || this.suspended) return;
        this.retryReason = reason;
        this.retrySequenceId ??= this.createRetrySequenceId();
        if (this.publishIncidentLimit()) return;
        this.scheduleRetry();
    }

    /**
     * The session budget outlives this pane, so it is consulted at every point that would rebuild WebGL. Once it trips,
     * the retry sequence ends here with a closed reason instead of an exhausted rolling window that a remount resets.
     */
    private publishIncidentLimit(): boolean {
        if (!this.policy.isPinnedToDom()) return false;
        if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
        this.retryDelayMs = null;
        this.retryState = 'exhausted';
        this.publish('context-loss-limit', 'gpu-incident-limit');
        this.retryReason = undefined;
        this.retrySequenceId = undefined;
        this.retryState = 'idle';
        return true;
    }

    private cancelRetry(): void {
        if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
        this.retryDelayMs = null;
        if (this.retrySequenceId && !['exhausted', 'idle', 'succeeded'].includes(this.retryState)) {
            this.retryState = 'cancelled';
            this.publish(this.retryReason ?? 'load-failed', 'webgl-retry-cancelled');
        }
        this.retryReason = undefined;
        this.retrySequenceId = undefined;
        this.retryState = 'idle';
    }

    private pruneRetryAttempts(): void {
        const cutoff = this.now() - TERMINAL_WEBGL_RETRY_WINDOW_MS;
        while (this.retryAttemptTimestamps.length > 0 && this.retryAttemptTimestamps[0] <= cutoff)
            this.retryAttemptTimestamps.shift();
    }

    private publishRetryExhausted(): void {
        if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
        this.retryDelayMs = null;
        this.retryState = 'exhausted';
        this.publish(this.retryReason ?? 'load-failed', 'webgl-retry-exhausted');
    }

    private retryWebgl(): void {
        this.retryTimer = undefined;
        this.retryDelayMs = null;
        if (this.disposed || this.suspended || this.preference === 'off' || !this.retrySequenceId)
            return;
        if (this.publishIncidentLimit()) return;
        if (!this.canRetryWebgl()) {
            this.retryState = 'deferred';
            this.publish(this.retryReason ?? 'load-failed', 'webgl-retry-deferred');
            return;
        }
        this.pruneRetryAttempts();
        if (this.retryAttemptTimestamps.length >= TERMINAL_WEBGL_RETRY_LIMIT) {
            this.publishRetryExhausted();
            return;
        }
        this.retryAttemptTimestamps.push(this.now());
        this.retryState = 'trying';
        this.publish(this.retryReason ?? 'load-failed', 'webgl-retry-attempt');
        if (!this.policy.isWebgl2Available()) {
            this.retryReason = 'load-failed';
            this.retryState = 'failed';
            this.publish('load-failed', 'webgl-retry-failed');
        } else if (this.activateWebgl('webgl-retry-succeeded', 'webgl-retry-failed')) return;
        if (this.retryAttemptTimestamps.length >= TERMINAL_WEBGL_RETRY_LIMIT) {
            this.publishRetryExhausted();
            return;
        }
        this.retryState = 'failed';
        this.scheduleRetry();
        this.publish(this.retryReason ?? 'load-failed', 'webgl-retry-scheduled');
    }

    private scheduleRetry(immediateDelayMs?: number): boolean {
        this.pruneRetryAttempts();
        if (this.retryAttemptTimestamps.length >= TERMINAL_WEBGL_RETRY_LIMIT) {
            this.publishRetryExhausted();
            return false;
        }
        const delayMs =
            immediateDelayMs ??
            terminalWebglRetryDelayMs(this.retryAttemptTimestamps.length, this.random);
        if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
        this.retryState = 'scheduled';
        this.retryDelayMs = delayMs;
        this.retryTimer = setTimeout(() => this.retryWebgl(), delayMs);
        return true;
    }

    private releaseWebglContextCount(): void {
        if (!this.isWebglContextCounted) return;
        this.isWebglContextCounted = false;
        this.policy.recordWebglContextReleased();
    }

    private disposeWebgl(): void {
        this.lossDisposable?.dispose();
        this.lossDisposable = undefined;
        const addon = this.webgl;
        this.webgl = undefined;
        this.releaseWebglContextCount();
        try {
            addon?.dispose();
        } catch {
            // DOM fallback must survive a broken or partially initialized WebGL disposer.
        }
    }

    private redrawTerminal(intent: TerminalRendererRedrawIntent): void {
        this.redraw(intent);
        this.redrawCount += 1;
    }

    private publish(
        reason: TerminalRendererReason,
        trigger: TerminalRendererTrigger,
        recoveryResult: TerminalRendererStatus['recoveryResult'] = 'not-requested',
    ): void {
        this.status = {
            contextLossCount: this.contextLossCount,
            liveWebglContextCount:
                this.webglContextCountAtLoss ?? this.policy.liveWebglContextCount(),
            mode: this.webgl ? 'webgl' : 'dom',
            reason,
            redrawCount: this.redrawCount,
            recoveryResult,
            retryAttemptCount: this.retryAttemptTimestamps.length,
            retryDelayMs: this.retryDelayMs,
            retryLimit: TERMINAL_WEBGL_RETRY_LIMIT,
            ...(this.retrySequenceId && { retrySequenceId: this.retrySequenceId }),
            retryState: this.retryState,
            trigger,
        };
        this.onStatus(this.status);
    }

    /**
     * A pane mounted while the GPU process was restarting saw `getContext('webgl2')` fail and would otherwise stay on
     * DOM until it was remounted. Window restore is the cheapest moment to ask again: a failed probe allocates nothing
     * and the session budget caches a positive answer, so this cannot become per-event context churn.
     */
    private reprobeWebgl(): void {
        if (this.policy.isPinnedToDom()) {
            this.redrawTerminal('content-only');
            this.publish('context-loss-limit', 'visibility-restore');
            return;
        }
        if (!this.policy.isWebgl2Available()) {
            this.redrawTerminal('content-only');
            this.publish('unsupported', 'visibility-restore');
            return;
        }
        this.activateWebgl('webgl-reprobe-succeeded', 'webgl-load-failed');
    }

    /**
     * Reason an already-DOM pane reports after a GPU incident. Once the session budget pins, a pane whose own retry
     * sequence was exhausted or still scheduled must converge on the closed reason too; otherwise the status bar keeps
     * promising that reopening the tab will retry WebGL, which the pin no longer allows.
     */
    private settledDomReason(): TerminalRendererReason {
        const current = this.status?.reason ?? 'disabled';
        if (current === 'disabled' || this.preference === 'off') return current;
        return this.policy.isPinnedToDom() ? 'context-loss-limit' : current;
    }

    /**
     * Releases the GPU context of a pane that is staying mounted but leaving the screen, which is what lets a Session
     * keep its Terminals alive in the background (issue #657). Everything that carries user state (xterm, its buffer
     * and scroll position, the PTY subscription, the Agent lifecycle) is untouched; only the context goes, because
     * Chromium caps a page at roughly 16 live WebGL contexts and force-loses the oldest past that, which
     * `gpu-incident-budget.ts` would then bank as a real incident and eventually pin every Terminal to DOM.
     *
     * Deliberately does not redraw: repainting a pane nobody can see is exactly the work the keep-alive exists to
     * avoid. `resume()` owns the redraw.
     */
    suspend(): void {
        if (this.disposed || this.suspended) return;
        this.suspended = true;
        this.cancelRetry();
        this.disposeWebgl();
        this.publish('suspended', 'keep-alive-suspend');
    }

    /**
     * Puts a suspended pane back on screen: reacquire WebGL when the preference and the session budget still allow it,
     * then sync the grid once so the DOM the user left behind matches the buffer that kept filling while hidden.
     */
    resume(): void {
        if (this.disposed || !this.suspended) return;
        this.suspended = false;
        if (this.preference === undefined) return;
        const isPinned = this.preference !== 'off' && this.policy.isPinnedToDom();
        const target = resolveTerminalRendererTarget(
            this.preference,
            this.preference !== 'off' && !isPinned && this.policy.isWebgl2Available(),
        );
        if (target === 'dom') {
            this.redrawTerminal('grid-sync');
            this.publish(
                this.preference === 'off'
                    ? 'disabled'
                    : isPinned
                      ? 'context-loss-limit'
                      : 'unsupported',
                'keep-alive-resume',
            );
            return;
        }
        if (!this.activateWebgl('preference-change', 'webgl-load-failed'))
            this.redrawTerminal('grid-sync');
    }

    setPreference(preference: TerminalGpuAcceleration): void {
        if (this.preference === preference) return;
        if (this.preference !== undefined) this.cancelRetry();
        this.retryAttemptTimestamps.length = 0;
        this.preference = preference;
        this.policy.applyPreference(preference);
        // A hidden pane records the preference but must not allocate a context for it; `resume()` applies it on the way
        // back to the screen.
        if (this.suspended) {
            this.publish('suspended', 'keep-alive-suspend');
            return;
        }
        const isPinned = preference !== 'off' && this.policy.isPinnedToDom();
        const target = resolveTerminalRendererTarget(
            preference,
            preference !== 'off' && !isPinned && this.policy.isWebgl2Available(),
        );
        if (target === 'dom') {
            const wasWebgl = Boolean(this.webgl);
            this.disposeWebgl();
            if (wasWebgl) this.redrawTerminal('grid-sync');
            this.publish(
                preference === 'off' ? 'disabled' : isPinned ? 'context-loss-limit' : 'unsupported',
                'preference-change',
            );
            return;
        }
        if (this.webgl) {
            this.publish('active', 'preference-change');
            return;
        }
        this.activateWebgl('preference-change', 'webgl-load-failed');
    }

    /**
     * One explicit attempt, without touching settings or the PTY. Cancel any pending automatic sequence first; failure
     * stays on DOM until another user action, while later context losses retain the normal retry limits.
     */
    retryFromUser(): boolean {
        if (
            this.disposed ||
            this.suspended ||
            this.preference === undefined ||
            this.preference === 'off'
        )
            return false;
        if (this.webgl) return true;
        this.cancelRetry();
        this.retryAttemptTimestamps.length = 0;
        this.policy.resetForManualRetry();
        this.retrySequenceId = this.createRetrySequenceId();
        this.retryAttemptTimestamps.push(this.now());
        this.retryState = 'trying';
        this.publish(this.status?.reason ?? 'load-failed', 'manual-retry');
        if (
            this.policy.isWebgl2Available() &&
            this.activateWebgl('webgl-retry-succeeded', 'webgl-retry-failed')
        )
            return true;
        this.retryReason = 'load-failed';
        this.publishRetryExhausted();
        return false;
    }

    /**
     * Clears stale atlas pixels after window restore, Space changes, or document visibility restore.
     */
    restoreVisible(): void {
        // A suspended pane is off screen by the keep-alive's decision, not by the window's: a window-restore event
        // must not hand it back a context it is not allowed to hold.
        if (this.disposed || this.suspended || this.preference === 'off' || !this.status) return;
        if (this.status.reason === 'context-loss-limit') {
            // The pin suppresses every WebGL rebuild, not the measurement: Main counts these restores to see how
            // often the user keeps switching back after the session settled on DOM.
            this.redrawTerminal('content-only');
            this.publish('context-loss-limit', 'visibility-restore');
            return;
        }
        if (this.status.reason === 'unsupported') {
            this.reprobeWebgl();
            return;
        }
        if (this.retryState === 'deferred') {
            if (!this.scheduleRetry(0)) return;
            this.publish(this.retryReason ?? 'load-failed', 'webgl-retry-scheduled');
            return;
        }
        try {
            this.webgl?.clearTextureAtlas();
        } catch {
            this.fallback('load-failed', 'atlas-clear-failed');
            return;
        }
        this.redrawTerminal('content-only');
        this.publish(this.webgl ? 'active' : this.status.reason, 'visibility-restore');
    }

    /**
     * Discards a context tied to Chromium's dead GPU process and rebuilds the visible DOM renderer only. The PTY, xterm
     * buffer, Terminal identity, and Agent lifecycle remain owned by their existing layers.
     */
    recoverFromGpuProcessLoss(): Exclude<
        TerminalRendererStatus['recoveryResult'],
        'not-requested'
    > {
        // A suspended pane holds no context, so a GPU process exit costs it nothing and must not be charged to the
        // incident budget as if it had lost one.
        if (this.suspended) return 'already-dom';
        this.webglContextCountAtLoss = this.policy.liveWebglContextCount();
        try {
            const isHadWebgl = Boolean(this.webgl);
            if (isHadWebgl) this.recordContextLoss();
            this.disposeWebgl();
            try {
                this.redrawTerminal(isHadWebgl ? 'grid-sync' : 'content-only');
            } catch {
                this.publish(
                    isHadWebgl ? 'context-loss' : (this.status?.reason ?? 'disabled'),
                    'gpu-process-recovery',
                    'failed',
                );
                return 'failed';
            }
            const result = isHadWebgl ? 'dom-restored' : 'already-dom';
            if (isHadWebgl) this.beginRetry('context-loss');
            // The session budget may have tripped on this very incident; the pane then settles on the closed reason,
            // and a pane still carrying a retry sequence from an earlier loss ends it here instead of re-arming later.
            const reason = isHadWebgl
                ? this.policy.isPinnedToDom()
                    ? 'context-loss-limit'
                    : 'context-loss'
                : this.settledDomReason();
            if (!isHadWebgl && reason === 'context-loss-limit' && this.retrySequenceId)
                this.publishIncidentLimit();
            this.publish(reason, 'gpu-process-recovery', result);
            return result;
        } finally {
            this.webglContextCountAtLoss = undefined;
        }
    }

    dispose(): void {
        this.cancelRetry();
        this.disposeWebgl();
        this.preference = undefined;
        this.publish('disposed', 'dispose');
        this.disposed = true;
    }
}
