import { useCallback, useSyncExternalStore } from 'react';

export type TerminalProgress =
    | { kind: 'error'; value: number }
    | { kind: 'indeterminate' }
    | { kind: 'normal'; value: number }
    | { kind: 'paused'; value: number };

export interface TerminalProgressUpdate {
    state: number;
    value: number;
}

export function terminalProgressLabel(progress: TerminalProgress): string {
    if (progress.kind === 'indeterminate') return 'In progress';
    if (progress.kind === 'error') return `Error ${progress.value}%`;
    if (progress.kind === 'paused') return `Paused ${progress.value}%`;
    return `${progress.value}%`;
}

export function terminalProgressAriaLabel(progress: TerminalProgress): string {
    if (progress.kind === 'indeterminate') return 'Terminal progress: in progress';
    if (progress.kind === 'error') return `Terminal progress: error at ${progress.value} percent`;
    if (progress.kind === 'paused') return `Terminal progress: paused at ${progress.value} percent`;
    return `Terminal progress: ${progress.value} percent`;
}

type RequestFrame = (callback: () => void) => number;
type CancelFrame = (frame: number) => void;

const INVALID_PROGRESS = Symbol('invalid-progress');

function normalizeProgress(
    update: TerminalProgressUpdate,
): TerminalProgress | undefined | typeof INVALID_PROGRESS {
    if (!Number.isInteger(update.state) || update.state < 0 || update.state > 4)
        return INVALID_PROGRESS;
    if (update.state === 0) return undefined;
    if (!Number.isFinite(update.value)) return INVALID_PROGRESS;
    const value = Math.round(Math.min(Math.max(update.value, 0), 100));
    if (update.state === 1) return { kind: 'normal', value };
    if (update.state === 2) return { kind: 'error', value };
    if (update.state === 3) return { kind: 'indeterminate' };
    return { kind: 'paused', value };
}

function progressEqual(left: TerminalProgress | undefined, right: TerminalProgress): boolean {
    if (left?.kind !== right.kind) return false;
    if (left.kind === 'indeterminate' || right.kind === 'indeterminate') return true;
    return left.value === right.value;
}

/**
 * Keeps OSC 9;4 state ephemeral and Terminal-scoped. PTYs can emit progress updates faster than
 * React can paint, so the registry publishes only the last update for each Terminal once per frame.
 */
export class TerminalProgressRegistry {
    private readonly current = new Map<string, TerminalProgress>();
    private readonly listeners = new Map<string, Set<() => void>>();
    private readonly pending = new Map<string, TerminalProgress | undefined>();
    private frame: number | undefined;

    constructor(
        private readonly requestFrame: RequestFrame = (callback) =>
            window.requestAnimationFrame(callback),
        private readonly cancelFrame: CancelFrame = (frame) => window.cancelAnimationFrame(frame),
    ) {}

    get(terminalId: string): TerminalProgress | undefined {
        return this.current.get(terminalId);
    }

    subscribe(terminalId: string, listener: () => void): () => void {
        const listeners = this.listeners.get(terminalId) ?? new Set<() => void>();
        listeners.add(listener);
        this.listeners.set(terminalId, listeners);
        return () => {
            listeners.delete(listener);
            if (listeners.size === 0) this.listeners.delete(terminalId);
        };
    }

    update(terminalId: string, update: TerminalProgressUpdate): void {
        const progress = normalizeProgress(update);
        if (progress === INVALID_PROGRESS) return;
        if (!progress) {
            this.clear(terminalId);
            return;
        }
        this.pending.set(terminalId, progress);
        if (this.frame !== undefined) return;
        this.frame = this.requestFrame(() => this.flush());
    }

    /** Lifecycle clears are synchronous so a queued frame cannot resurrect a closed Terminal. */
    clear(terminalId: string): void {
        this.pending.delete(terminalId);
        const changed = this.current.delete(terminalId);
        if (this.pending.size === 0 && this.frame !== undefined) {
            this.cancelFrame(this.frame);
            this.frame = undefined;
        }
        if (changed) this.notify(terminalId);
    }

    retain(terminalIds: ReadonlySet<string>): void {
        const tracked = new Set([...this.current.keys(), ...this.pending.keys()]);
        for (const terminalId of tracked) if (!terminalIds.has(terminalId)) this.clear(terminalId);
    }

    private flush(): void {
        this.frame = undefined;
        const updates = [...this.pending];
        this.pending.clear();
        for (const [terminalId, progress] of updates) {
            if (!progress) continue;
            if (progressEqual(this.current.get(terminalId), progress)) continue;
            this.current.set(terminalId, progress);
            this.notify(terminalId);
        }
    }

    private notify(terminalId: string): void {
        for (const listener of this.listeners.get(terminalId) ?? []) listener();
    }
}

const terminalProgressRegistry = new TerminalProgressRegistry();

export function updateTerminalProgress(terminalId: string, update: TerminalProgressUpdate): void {
    terminalProgressRegistry.update(terminalId, update);
}

export function clearTerminalProgress(terminalId: string): void {
    terminalProgressRegistry.clear(terminalId);
}

export function retainTerminalProgress(terminalIds: ReadonlySet<string>): void {
    terminalProgressRegistry.retain(terminalIds);
}

export function useTerminalProgress(terminalId: string): TerminalProgress | undefined {
    const subscribe = useCallback(
        (listener: () => void) => terminalProgressRegistry.subscribe(terminalId, listener),
        [terminalId],
    );
    const getSnapshot = useCallback(() => terminalProgressRegistry.get(terminalId), [terminalId]);
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
