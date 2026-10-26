import type { ProcessState } from '@caxri/protocol';
import { notifyListeners } from '@caxri/utils';

/**
 * What the Renderer learned about the last time one Terminal's process ended. The durable record only keeps a coarse
 * `dead`, so the exit code, signal, and how long the process ran live here, from the `terminal.exit` event.
 */
export interface TerminalExitInfo {
    exitCode: number;
    signal?: number;
    /**
     * Milliseconds between the Renderer first seeing the process run and its exit. Absent when this window did not see
     * the launch (the app reopened with the process already running), so "exited right after starting" is never claimed
     * without evidence.
     */
    ranForMs?: number;
}

/**
 * A process that ends this soon after launch almost always failed to start (bad flags, missing login, broken install),
 * which is a different problem from an Agent that worked for a while and then died.
 */
export const EARLY_EXIT_THRESHOLD_MS = 5_000;

/**
 * Bounds the exit map for a long-lived window. No event says a Terminal was removed, and a pane that unmounts on a tab
 * switch must still show its exit when it returns, so the oldest recorded exits are evicted instead.
 */
export const MAX_TERMINAL_EXIT_ENTRIES = 200;

const exits = new Map<string, TerminalExitInfo>();
const runStarts = new Map<string, number>();
/**
 * The last state each mounted pane reported, so a run clock only starts on a transition this window watched.
 */
const lastStates = new Map<string, ProcessState>();
const listeners = new Set<(value: undefined) => void>();

function emit(): void {
    notifyListeners(listeners, undefined);
}

export function subscribeTerminalExitInfo(listener: () => void): () => void {
    const wrapped = (): void => listener();
    listeners.add(wrapped);
    return () => listeners.delete(wrapped);
}

export function getTerminalExitInfo(terminalId: string): TerminalExitInfo | undefined {
    return exits.get(terminalId);
}

/**
 * Tracks launch time from the process state the pane renders. A new run clears the previous exit so a restarted
 * Terminal never shows the old code.
 */
export function noteTerminalProcessState(
    terminalId: string,
    state: ProcessState,
    now = Date.now(),
): void {
    const previous = lastStates.get(terminalId);
    lastStates.set(terminalId, state);
    if (state === 'starting' || state === 'running') {
        // A pane that mounts on an already running process has seen no launch: its mount time says nothing about how
        // long the process has run, so only `starting`, or `running` right after an observed stop, begins the clock.
        const isLaunchObserved =
            state === 'starting' || (previous !== undefined && previous !== 'running');
        if (isLaunchObserved && !runStarts.has(terminalId)) runStarts.set(terminalId, now);
        if (exits.delete(terminalId)) emit();
        return;
    }
    runStarts.delete(terminalId);
}

/**
 * Forgets what a pane watched when it unmounts: nothing is observed while no pane is mounted, so a later mount must not
 * treat the gap as a transition or inherit a stale run clock.
 */
export function forgetTerminalProcessState(terminalId: string): void {
    lastStates.delete(terminalId);
    runStarts.delete(terminalId);
}

export function recordTerminalExit(
    payload: { terminalId: string; exitCode: number; signal?: number },
    now = Date.now(),
): void {
    const startedAt = runStarts.get(payload.terminalId);
    runStarts.delete(payload.terminalId);
    exits.delete(payload.terminalId);
    if (exits.size >= MAX_TERMINAL_EXIT_ENTRIES) {
        const oldest = exits.keys().next().value;
        if (oldest !== undefined) exits.delete(oldest);
    }
    exits.set(payload.terminalId, {
        exitCode: payload.exitCode,
        // The Terminal Host reports 0 when no signal ended the process.
        ...(payload.signal && { signal: payload.signal }),
        ...(startedAt !== undefined && { ranForMs: Math.max(0, now - startedAt) }),
    });
    emit();
}

export function resetTerminalExitInfoForTest(): void {
    exits.clear();
    runStarts.clear();
    lastStates.clear();
}
