import type { AgentOperation } from '@caxri/protocol';

import type { AgentLifecycleSignal } from './hooks/contract';

/**
 * A single Escape byte submitted on its own is the user interrupting the Agent. Exact matching excludes Shift+Enter and
 * navigation escape sequences, which arrive as longer payloads.
 */
export function isStandaloneEscape(data: string): boolean {
    return data === '\u{1B}';
}

/**
 * Main-thread phases a provider sends only from inside a running turn, without ending it.
 */
const midTurnPhases: ReadonlySet<AgentLifecycleSignal['phase']> = new Set([
    'attentionRequested',
    'attentionResolved',
    'shellToolFailed',
    'shellToolFinished',
    'shellToolStarted',
    'toolBatchFinished',
]);

/**
 * Whether a signal proves the main turn is still running. A {@link isStandaloneEscape} keystroke is taken as an
 * interrupt at face value, so an Escape the TUI consumed for something else (closing a picker) also ends the turn for
 * every consumer that tracks one; this is the evidence that heals that misread. A subagent signal (`agentId` set) says
 * nothing about the main turn. `sessionIdentified` and compaction are excluded because SessionStart also fires at
 * launch and resume, and a manual compaction runs between turns.
 */
export function isMidTurnSignal(signal: Pick<AgentLifecycleSignal, 'agentId' | 'phase'>): boolean {
    return signal.agentId === undefined && midTurnPhases.has(signal.phase);
}

/**
 * How long after an interrupt a main-scope mid-turn signal is treated as the interrupted turn's own late hook. A hook
 * runs through a bridge process and a socket while an Escape travels Core's input channel directly, so the server can
 * see the Escape first and the `PostToolBatch`/`PostToolUse` the provider emitted just before it second. Such a signal
 * must not reopen the turn: a real interrupt produces no `Stop`, so a reopened turn would never close. This is an
 * estimate; the real Claude and Codex post-interrupt hook timing has not been measured (see docs/agent-suspension.md).
 */
export const LATE_MID_TURN_SIGNAL_WINDOW_MS = 2000;

/**
 * Whether a signal is a mid-turn signal that arrived within {@link LATE_MID_TURN_SIGNAL_WINDOW_MS} after the interrupt
 * at `interruptedAt`. Past the window a mid-turn signal still proves an Escape only closed a picker and reopens the
 * turn. Shared by terminal suspension and Caxri Bot's completion notifier so both read an interrupt the same way.
 */
export function isLateMidTurnSignalAfterInterrupt(
    signal: Pick<AgentLifecycleSignal, 'agentId' | 'phase'>,
    interruptedAt: number | undefined,
    now: number,
): boolean {
    return (
        interruptedAt !== undefined &&
        now - interruptedAt <= LATE_MID_TURN_SIGNAL_WINDOW_MS &&
        isMidTurnSignal(signal)
    );
}

interface RunningTurnIdentity {
    agentTurnId: string;
    launchId: string;
    timeout?: NodeJS.Timeout;
}

/**
 * Owns bounded lifecycle timers whose provider completion hook may be lost. Running-turn checks never infer completion
 * from elapsed time: the caller must reconcile the provider's durable state and explicitly report whether the exact
 * turn is still running. Codex has a confirmed path that completes without its `Stop` hook:
 * https://github.com/openai/codex/issues/38213
 */
export class AgentLifecycleWatchdogs {
    private readonly compactionTimeouts = new Map<string, NodeJS.Timeout>();
    private readonly operations = new Map<string, AgentOperation>();
    private readonly runningTurns = new Map<string, RunningTurnIdentity>();

    constructor(
        private readonly compactionTimeoutMs: number,
        private readonly runningTurnIntervalMs: number,
        private readonly onOperationChange: (terminalId: string) => void,
        private readonly shouldRecheckRunningTurn: (
            terminalId: string,
            launchId: string,
        ) => Promise<boolean>,
    ) {}

    private armRunningTurn(terminalId: string, identity: RunningTurnIdentity): void {
        const timeout = setTimeout(() => {
            identity.timeout = undefined;
            void this.checkRunningTurn(terminalId, identity);
        }, this.runningTurnIntervalMs);
        timeout.unref();
        identity.timeout = timeout;
    }

    private async checkRunningTurn(
        terminalId: string,
        identity: RunningTurnIdentity,
    ): Promise<void> {
        try {
            const isStillRunning = await this.shouldRecheckRunningTurn(
                terminalId,
                identity.launchId,
            );
            if (this.runningTurns.get(terminalId) !== identity) return;
            /**
             * Re-arm only a running turn, but retain a settled turn's identity for ordinary metadata probes. Codex
             * remains alive at its prompt, so dropping the exact turn would let process state overwrite the reconciled
             * terminal status.
             */
            if (isStillRunning) this.armRunningTurn(terminalId, identity);
        } catch {
            if (this.runningTurns.get(terminalId) === identity)
                this.armRunningTurn(terminalId, identity);
        }
    }

    operation(terminalId: string): AgentOperation | undefined {
        return this.operations.get(terminalId);
    }

    startCompaction(terminalId: string): void {
        const existingTimeout = this.compactionTimeouts.get(terminalId);
        if (existingTimeout) clearTimeout(existingTimeout);
        const wasCompacting = this.operations.get(terminalId) === 'compacting';
        this.operations.set(terminalId, 'compacting');
        const timeout = setTimeout(
            () => this.clearCompaction(terminalId),
            this.compactionTimeoutMs,
        );
        timeout.unref();
        this.compactionTimeouts.set(terminalId, timeout);
        if (!wasCompacting) this.onOperationChange(terminalId);
    }

    /**
     * Returns whether a compaction was in progress.
     */
    clearCompaction(terminalId: string, shouldNotify = true): boolean {
        const timeout = this.compactionTimeouts.get(terminalId);
        if (timeout) clearTimeout(timeout);
        this.compactionTimeouts.delete(terminalId);
        const hadOperation = this.operations.delete(terminalId);
        if (shouldNotify && hadOperation) this.onOperationChange(terminalId);
        return hadOperation;
    }

    startRunningTurn(terminalId: string, launchId: string, agentTurnId: string): void {
        this.stopRunningTurn(terminalId);
        const identity = { agentTurnId, launchId };
        this.runningTurns.set(terminalId, identity);
        this.armRunningTurn(terminalId, identity);
    }

    stopRunningTurn(terminalId: string): void {
        const identity = this.runningTurns.get(terminalId);
        if (identity?.timeout) clearTimeout(identity.timeout);
        this.runningTurns.delete(terminalId);
    }

    agentTurnId(terminalId: string): string | undefined {
        return this.runningTurns.get(terminalId)?.agentTurnId;
    }

    forget(terminalId: string, shouldNotify = false): void {
        this.clearCompaction(terminalId, shouldNotify);
        this.stopRunningTurn(terminalId);
    }

    close(): void {
        for (const timeout of this.compactionTimeouts.values()) clearTimeout(timeout);
        for (const identity of this.runningTurns.values())
            if (identity.timeout) clearTimeout(identity.timeout);
        this.compactionTimeouts.clear();
        this.operations.clear();
        this.runningTurns.clear();
    }
}
