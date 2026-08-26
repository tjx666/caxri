import type {
    AgentOutputRecoverySettings,
    TerminalHostDiagnostics,
    TerminalRecord,
    TerminalResourceUsage,
    TerminalSnapshot,
} from '@caxri/protocol';

export type TerminalExecutionEvent =
    | {
          type: 'output';
          terminalId: string;
          data: string;
          droppedBytes?: number;
      }
    | {
          type: 'outputRecovery';
          terminalId: string;
          provider: NonNullable<TerminalRecord['provider']>;
          status: 'recovered' | 'rate-limited';
      }
    | { type: 'activity'; terminalId: string; processId: number }
    | { type: 'title'; terminalId: string; title: string };

export interface TerminalExecutionExit {
    capture: Promise<TerminalSnapshot>;
    exitCode: number;
    record: TerminalRecord;
    signal?: number;
}

export interface TerminalExecutionLaunch {
    args: string[];
    colors?: { background: string; foreground: string };
    environment: NodeJS.ProcessEnv;
    executable: string;
    initialSnapshot: TerminalSnapshot | null;
    outputRecovery?: AgentOutputRecoverySettings;
    record: TerminalRecord;
}

/**
 * Core-facing execution boundary. Hot-path methods retain the existing synchronous acceptance contract while the
 * process-backed implementation sends ordered private requests and fences their asynchronous failures internally.
 */
export interface TerminalExecutionPort {
    attach(
        terminalId: string,
        size?: { cols: number; rows: number },
    ): Promise<{ snapshot: TerminalSnapshot | null; wasAttached: boolean }>;
    close(terminalId: string): void;
    configureOutputRecovery(
        terminalId: string,
        provider: TerminalRecord['provider'],
        settings?: AgentOutputRecoverySettings,
    ): void;
    discard(terminalId: string): void;
    detachAllViews(): void;
    detachView(terminalId: string): void;
    diagnostics(): TerminalHostDiagnostics;
    onEvent(listener: (event: TerminalExecutionEvent) => void): () => void;
    onExit(listener: (event: TerminalExecutionExit) => void): () => void;
    onHostExit(listener: (terminalIds: readonly string[]) => void): () => void;
    processId(terminalId: string): number | undefined;
    reassignSession(terminalId: string, sessionId: string): void;
    reserve(record: TerminalRecord): Promise<void>;
    resize(terminalId: string, cols: number, rows: number): boolean;
    resources(terminalId: string): Promise<TerminalResourceUsage | null>;
    restartBarrier(terminalId: string): Promise<TerminalSnapshot | null>;
    runningCount(sessionId?: string): number;
    shutdown(): Promise<Array<{ terminalId: string; capture: Promise<TerminalSnapshot> }>>;
    signalExact(terminalId: string, expectedProcessId: number, signal: string): boolean;
    snapshot(terminalId: string): Promise<TerminalSnapshot | null>;
    start(input: TerminalExecutionLaunch): Promise<number>;
    terminateSession(sessionId: string, terminalIds: readonly string[]): string[];
    waitForAttachedSize(
        terminalId: string,
        timeoutMs: number,
        abortSignal?: AbortSignal,
    ): Promise<void>;
    write(terminalId: string, data: string): boolean;
}
