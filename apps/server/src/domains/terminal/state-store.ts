import type {
    ProcessState,
    TerminalFailureReason,
    TerminalRecord,
    TerminalSnapshot,
} from '@caxri/protocol';

import type { ShutdownReason } from '../db';

/**
 * Durable Core-owned state used by Terminal coordination. The execution owner never receives a database handle; the
 * future private client projects Host events through this seam instead.
 */
export interface TerminalStateStore {
    closeTerminal(id: string): void;
    getSnapshot(terminalId: string): TerminalSnapshot | undefined;
    getTerminal(id: string): TerminalRecord | undefined;
    listTerminals(sessionId?: string): TerminalRecord[];
    markShutdown(reason: ShutdownReason): void;
    saveSnapshot(snapshot: TerminalSnapshot): void;
    setTerminalPtyTitle(id: string, ptyTitle: string): boolean;
    /**
     * Persists a real PTY exit and returns the primary Agent Session whose activity advanced.
     */
    updateTerminalExitState(id: string, state: 'dead' | 'stopped'): string | undefined;
    /**
     * Persists a real Agent child-process exit and returns the Session whose live primary Agent changed.
     */
    updateAgentProcessExitState(id: string, state: 'dead' | 'stopped'): string | undefined;
    updateAgentProcessState(id: string, state: ProcessState): void;
    updateTerminalState(
        id: string,
        state: ProcessState,
        failureReason?: TerminalFailureReason,
        failureDetail?: string,
    ): void;
}
