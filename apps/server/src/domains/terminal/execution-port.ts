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
    | {
          type: 'sizeOwnership';
          terminalId: string;
          owner: 'desktop' | 'mobile';
          cols: number;
          rows: number;
      }
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

export type TerminalObserverEvent =
    | { type: 'output'; terminalId: string; generation: number; sequence: number; data: string }
    | {
          type: 'gap';
          terminalId: string;
          generation: number;
          sequence: number;
          reason: 'resize' | 'overflow';
      };

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
 * Core-facing execution boundary. Renderer-owned hot paths retain synchronous acceptance, while exact managed-Agent
 * input waits for the private Host to authorize and deliver the requested launch generation.
 */
export interface TerminalExecutionPort {
    attach(
        terminalId: string,
        size?: { cols: number; rows: number },
    ): Promise<{ snapshot: TerminalSnapshot | null; wasAttached: boolean }>;
    /**
     * Permanently removes the durable Terminal; its ID will not be reused and its Core generation can be forgotten.
     */
    close(terminalId: string): void;
    configureOutputRecovery(
        terminalId: string,
        provider: TerminalRecord['provider'],
        settings?: AgentOutputRecoverySettings,
    ): void;
    /**
     * Retires a failed launch while preserving its durable record and the generation required by a later restart.
     */
    discard(terminalId: string): void;
    detachAllViews(): void;
    detachView(terminalId: string): void;
    observe(
        terminalId: string,
        observerId: string,
    ): Promise<{ snapshot: TerminalSnapshot | null; nextSequence: number; generation: number }>;
    unobserve(terminalId: string, observerId: string): Promise<void>;
    onObserverEvent(listener: (event: TerminalObserverEvent) => void): () => void;
    takeOver(
        terminalId: string,
        holderId: string,
        expectedGeneration: number,
        size: { cols: number; rows: number },
        timeoutMs: number,
    ): Promise<{ expiresAt: number }>;
    renewTakeOver(
        terminalId: string,
        holderId: string,
        expectedGeneration: number,
        timeoutMs: number,
    ): Promise<{ expiresAt: number }>;
    releaseTakeOver(
        terminalId: string,
        holderId: string,
        expectedGeneration: number,
    ): Promise<void>;
    inputForGeneration(
        terminalId: string,
        expectedGeneration: number,
        data: string,
        signal?: AbortSignal,
    ): Promise<boolean>;
    onEvent(listener: (event: TerminalExecutionEvent) => void): () => void;
    onExit(listener: (event: TerminalExecutionExit) => void): () => void;
    onHostExit(listener: (terminalIds: readonly string[]) => void): () => void;
    agentLaunchId(terminalId: string): string | undefined;
    /**
     * Called before Server Core's own `stop()` sends the graceful shutdown request, so a Terminal Host exit caused by
     * an external signal (e.g. the OS tearing down the whole process tree) is recognized as expected teardown rather
     * than an unexpected crash. Optional: fakes and in-memory adapters used in tests have no such distinction to make.
     */
    markCoreStopping?(): void;
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
    textTail?(terminalId: string, maximumCharacters: number): Promise<string | null>;
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
        encoding?: 'binary',
    ): Promise<boolean>;
    /**
     * Admits Agent input for one exact launch in a single synchronous turn, which is what lets a caller claim the
     * Terminal and write without an `await` in between.
     *
     * A Terminal with no Renderer attachment cannot be answered that quickly: the write travels to the Terminal Host,
     * so the synchronous `true` only means "accepted for delivery". `onDelivered` then reports what the Host actually
     * did, and is called exactly once for that path — never for an attached Terminal, whose return value is already the
     * admission result.
     */
    writeAgentExact(
        terminalId: string,
        data: string,
        expectedAgentLaunchId: string,
        onDelivered?: (wasAccepted: boolean) => void,
        encoding?: 'binary',
    ): boolean;
    writeAgent(terminalId: string, data: string, signal?: AbortSignal): Promise<boolean>;
    submitAgentExact(
        terminalId: string,
        expectedSessionId: string,
        expectedAgentLaunchId: string,
        text: string,
        signal?: AbortSignal,
    ): Promise<'accepted' | 'rejected' | 'unknown'>;
}
