import type { AppSettings } from '@caxri/protocol';
import { WebglAddon } from '@xterm/addon-webgl';
import type { IDisposable, ITerminalAddon } from '@xterm/xterm';

export type TerminalGpuAcceleration = AppSettings['terminal.gpuAcceleration'];
export type TerminalRendererMode = 'dom' | 'webgl';
export type TerminalRendererReason =
    'active' | 'context-loss' | 'disabled' | 'disposed' | 'load-failed' | 'unsupported';
export type TerminalRendererTrigger =
    | 'atlas-clear-failed'
    | 'dispose'
    | 'gpu-process-recovery'
    | 'preference-change'
    | 'visibility-restore'
    | 'webgl-context-loss'
    | 'webgl-load-failed';

export interface TerminalRendererStatus {
    contextLossCount: number;
    mode: TerminalRendererMode;
    reason: TerminalRendererReason;
    redrawCount: number;
    recoveryResult: 'not-requested' | 'already-dom' | 'dom-restored' | 'failed';
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

export function resolveTerminalRendererTarget(
    preference: TerminalGpuAcceleration,
    isWebgl2Available: boolean,
): TerminalRendererMode {
    if (preference === 'off') return 'dom';
    if (preference === 'auto' && !isWebgl2Available) return 'dom';
    return 'webgl';
}

/**
 * Owns the replaceable xterm renderer only. Falling back disposes WebGL and asks xterm to redraw; it never touches the
 * Server, PTY, buffer, or Agent lifecycle.
 */
export class TerminalRendererController {
    private contextLossCount = 0;
    private lossDisposable: IDisposable | undefined;
    private preference: TerminalGpuAcceleration | undefined;
    private redrawCount = 0;
    private status: TerminalRendererStatus | undefined;
    private webgl: WebglRendererAddon | undefined;

    constructor(
        private readonly host: TerminalRendererHost,
        private readonly redraw: () => void,
        private readonly onStatus: (status: TerminalRendererStatus) => void,
        // DOM lib types declare `WebGL2RenderingContext` as always present, but this checks whether the runtime
        // environment (e.g. a WebGL2-less Electron/GPU configuration) actually exposes it.
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- see comment above
        private readonly webgl2Available = () => globalThis.WebGL2RenderingContext !== undefined,
        private readonly createWebglAddon: WebglAddonFactory = () => new WebglAddon(),
    ) {}

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
        this.redrawTerminal();
        this.publish(reason, trigger);
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

    private redrawTerminal(): void {
        this.redraw();
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
            trigger,
        };
        this.onStatus(this.status);
    }

    setPreference(preference: TerminalGpuAcceleration): void {
        if (this.preference === preference) return;
        this.preference = preference;
        const target = resolveTerminalRendererTarget(preference, this.webgl2Available());
        if (target === 'dom') {
            const wasWebgl = Boolean(this.webgl);
            this.disposeWebgl();
            if (wasWebgl) this.redrawTerminal();
            this.publish(preference === 'off' ? 'disabled' : 'unsupported', 'preference-change');
            return;
        }
        if (this.webgl) {
            this.publish('active', 'preference-change');
            return;
        }
        let addon: WebglRendererAddon | undefined;
        try {
            addon = this.createWebglAddon();
            this.webgl = addon;
            this.lossDisposable = addon.onContextLoss(() => this.handleContextLoss());
            this.host.loadAddon(addon);
            this.publish('active', 'preference-change');
        } catch {
            this.lossDisposable?.dispose();
            this.lossDisposable = undefined;
            if (this.webgl === addon) this.webgl = undefined;
            try {
                addon?.dispose();
            } catch {
                // A partially activated addon must still fail closed to xterm's DOM renderer.
            }
            this.redrawTerminal();
            this.publish('load-failed', 'webgl-load-failed');
        }
    }

    /**
     * Clears stale atlas pixels after window restore, Space changes, or document visibility restore.
     */
    restoreVisible(): void {
        if (this.preference === 'off' || !this.status || this.status.reason === 'unsupported')
            return;
        try {
            this.webgl?.clearTextureAtlas();
        } catch {
            this.fallback('load-failed', 'atlas-clear-failed');
            return;
        }
        this.redrawTerminal();
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
        this.disposeWebgl();
        try {
            this.redrawTerminal();
        } catch {
            this.publish(
                isHadWebgl ? 'context-loss' : (this.status?.reason ?? 'disabled'),
                'gpu-process-recovery',
                'failed',
            );
            return 'failed';
        }
        const result = isHadWebgl ? 'dom-restored' : 'already-dom';
        this.publish(
            isHadWebgl ? 'context-loss' : (this.status?.reason ?? 'disabled'),
            'gpu-process-recovery',
            result,
        );
        return result;
    }

    dispose(): void {
        this.disposeWebgl();
        this.preference = undefined;
        this.publish('disposed', 'dispose');
    }
}
