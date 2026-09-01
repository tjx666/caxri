import type {
    AgentOutputRecoverySettings,
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
    | { type: 'title'; terminalId: string; title: string }
    | {
          type: 'agentStarted';
          terminalId: string;
          launchId: string;
          processId: number;
      }
    | {
          type: 'agentExit';
          terminalId: string;
          launchId: string;
          exitCode: number | null;
          signal?: NodeJS.Signals;
      };

export interface TerminalExecutionExit {
    capture: Promise<TerminalSnapshot>;
    exitCode: number;
    record: TerminalRecord;
    signal?: number;
}

export interface TerminalExecutionLaunch {
    agent?: {
        args: string[];
        environment: NodeJS.ProcessEnv;
        executable: string;
        launchId: string;
        provider: NonNullable<TerminalRecord['provider']>;
    };
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
    onEvent(listener: (event: TerminalExecutionEvent) => void): () => void;
    onExit(listener: (event: TerminalExecutionExit) => void): () => void;
    onHostExit(listener: (terminalIds: readonly string[]) => void): () => void;
    agentLaunchId(terminalId: string): string | undefined;
    agentProcessId(terminalId: string): number | undefined;
    processId(terminalId: string): number | undefined;
    reassignSession(terminalId: string, sessionId: string): void;
    reserve(record: TerminalRecord): Promise<void>;
    resize(terminalId: string, cols: number, rows: number): boolean;
    resources(terminalId: string): Promise<TerminalResourceUsage | null>;
    restartBarrier(terminalId: string): Promise<TerminalSnapshot | null>;
    runningCount(sessionId?: string): number;
    shutdown(): Promise<Array<{ terminalId: string; capture: Promise<TerminalSnapshot> }>>;
    signalAgentExact(terminalId: string, expectedLaunchId: string, signal: string): boolean;
    signalExact(terminalId: string, expectedProcessId: number, signal: string): boolean;
    snapshot(terminalId: string): Promise<TerminalSnapshot | null>;
    start(input: TerminalExecutionLaunch): Promise<number>;
    terminateSession(sessionId: string, terminalIds: readonly string[]): string[];
    /**
     * An abort resolves the attachment wait; the caller then revalidates its restore generation and leaves stale work
     * interrupted. Transport adapters must not turn that expected cancellation into a launch failure.
     */
    waitForAttachedSize(
        terminalId: string,
        timeoutMs: number,
        abortSignal?: AbortSignal,
    ): Promise<void>;
    write(terminalId: string, data: string): boolean;
    /**
     * Resolves after the private Terminal Host acknowledges every ordered input frame.
     */
    writeAcknowledged(
        terminalId: string,
        data: string,
        abortSignal?: AbortSignal,
    ): Promise<boolean>;
    writeAgentExact(terminalId: string, data: string, expectedAgentLaunchId: string): boolean;
}
