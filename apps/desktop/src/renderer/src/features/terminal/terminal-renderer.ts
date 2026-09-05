import type { AppSettings } from '@caxri/protocol';
import { WebglAddon } from '@xterm/addon-webgl';
import type { IDisposable, ITerminalAddon } from '@xterm/xterm';

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
    | 'preference-change'
    | 'visibility-restore'
    | 'webgl-context-loss'
    | 'webgl-load-failed'
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

/**
 * Session-wide WebGL policy shared by every mounted Terminal. The controller is rebuilt on each tab switch, so anything
 * that must outlive a pane (the GPU incident budget, the cached WebGL2 probe) lives behind this seam.
 */
export interface TerminalWebglSessionPolicy {
    /**
     * Records the preference each pane applies; an actual change is the user's request to try WebGL again.
     */
    applyPreference(preference: TerminalGpuAcceleration): void;
    isPinnedToDom(): boolean;
    isWebgl2Available(): boolean;
}

export interface TerminalRendererControllerOptions {
    canRetryWebgl?: () => boolean;
    createRetrySequenceId?: () => string;
    createWebglAddon?: WebglAddonFactory;
    now?: () => number;
    policy?: TerminalWebglSessionPolicy;
    /**
     * Unit interval source for retry jitter; injected so tests can pin the delay.
     */
    random?: () => number;
}

const UNPINNED_SESSION_POLICY: TerminalWebglSessionPolicy = {
    applyPreference: () => {},
    isPinnedToDom: () => false,
    isWebgl2Available,
};

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
 * Probes the capability xterm actually needs instead of constructor presence, which remains truthy when Chromium cannot
 * create a WebGL2 context. The temporary context is released immediately so probing cannot evict a live Terminal
 * context from Chromium's per-page limit.
 */
export function isWebgl2Available(): boolean {
    try {
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('webgl2');
        if (!context) return false;
        try {
            return true;
        } finally {
            context.getExtension('WEBGL_lose_context')?.loseContext();
        }
    } catch {
        return false;
    }
}

/**
 * Owns the replaceable xterm renderer only. Falling back disposes WebGL and asks xterm to redraw; it never touches the
 * Server, PTY, buffer, or Agent lifecycle.
 */
export class TerminalRendererController {
    private contextLossCount = 0;
    private disposed = false;
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
    private webgl: WebglRendererAddon | undefined;

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
        options: TerminalRendererControllerOptions = {},
    ) {
        this.canRetryWebgl =
            options.canRetryWebgl ?? (() => document.visibilityState === 'visible');
        this.createRetrySequenceId = options.createRetrySequenceId ?? (() => crypto.randomUUID());
        this.createWebglAddon = options.createWebglAddon ?? (() => new WebglAddon());
        this.now = options.now ?? (() => Date.now());
        this.policy = options.policy ?? UNPINNED_SESSION_POLICY;
        this.random = options.random ?? Math.random;
    }

    private handleContextLoss(): void {
        if (!this.webgl) return;
        this.contextLossCount += 1;
        this.fallback('context-loss', 'webgl-context-loss');
    }

    private fallback(
        reason: Extract<TerminalRendererReason, 'context-loss' | 'load-failed'>,
        trigger: Extract<TerminalRendererTrigger, 'atlas-clear-failed' | 'webgl-context-loss'>,
    ): void {
        this.disposeWebgl();
        this.redrawTerminal('grid-sync');
        this.beginRetry(reason);
        this.publish(reason, trigger);
    }

    private activateWebgl(
        successTrigger: Extract<
            TerminalRendererTrigger,
            'preference-change' | 'webgl-retry-succeeded'
        >,
        failureTrigger: Extract<
            TerminalRendererTrigger,
            'webgl-load-failed' | 'webgl-retry-failed'
        >,
    ): boolean {
        let addon: WebglRendererAddon | undefined;
        try {
            addon = this.createWebglAddon();
            this.webgl = addon;
            this.lossDisposable = addon.onContextLoss(() => this.handleContextLoss());
            this.host.loadAddon(addon);
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
            this.lossDisposable?.dispose();
            this.lossDisposable = undefined;
            if (this.webgl === addon) this.webgl = undefined;
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
        if (this.preference === 'off' || this.disposed) return;
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
        if (this.disposed || this.preference === 'off' || !this.retrySequenceId) return;
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

    private disposeWebgl(): void {
        this.lossDisposable?.dispose();
        this.lossDisposable = undefined;
        const addon = this.webgl;
        this.webgl = undefined;
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

    setPreference(preference: TerminalGpuAcceleration): void {
        if (this.preference === preference) return;
        if (this.preference !== undefined) this.cancelRetry();
        this.retryAttemptTimestamps.length = 0;
        this.preference = preference;
        this.policy.applyPreference(preference);
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
     * Clears stale atlas pixels after window restore, Space changes, or document visibility restore.
     */
    restoreVisible(): void {
        if (
            this.preference === 'off' ||
            !this.status ||
            this.status.reason === 'unsupported' ||
            this.status.reason === 'context-loss-limit'
        )
            return;
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
        const isHadWebgl = Boolean(this.webgl);
        if (isHadWebgl) this.contextLossCount += 1;
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
        // The session budget may have tripped on this very incident; the pane then settles on the closed reason.
        const reason: TerminalRendererReason = isHadWebgl
            ? this.policy.isPinnedToDom()
                ? 'context-loss-limit'
                : 'context-loss'
            : (this.status?.reason ?? 'disabled');
        this.publish(reason, 'gpu-process-recovery', result);
        return result;
    }

    dispose(): void {
        this.cancelRetry();
        this.disposeWebgl();
        this.preference = undefined;
        this.publish('disposed', 'dispose');
        this.disposed = true;
    }
}
