import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';

import type {
    AgentChatDecision,
    AgentChatFailureReason,
    AgentChatMessageInput,
    AgentChatModelChange,
    AgentChatPatchOperation,
    AgentChatSnapshot,
    AgentChatTaskPatchOperation,
    AgentChatTaskSnapshot,
    AgentChatTurn,
    AgentLaunchSettings,
} from '@caxri/protocol';

import type { AgentLifecycleSignal } from '../agents';

/**
 * The seam between `AgentChatService` and one provider's structured protocol. The service owns the Terminal row, the
 * projection, revisions, and lifecycle delivery; a provider session only translates its protocol into projection
 * operations and lifecycle events through {@link AgentChatSessionHost}. Adding a provider means adding a driver to
 * `agentChatDrivers`, not another branch in the service. See `docs/agent-chat.md`.
 */

type ChatLifecyclePhase = Extract<
    AgentLifecycleSignal['phase'],
    | 'attentionRequested'
    | 'attentionResolved'
    | 'compactionFinished'
    | 'compactionStarted'
    | 'sessionIdentified'
    | 'turnFailed'
    | 'turnFinished'
    | 'turnStarted'
>;

export interface ChatLifecycleEvent {
    phase: ChatLifecyclePhase;
    agentSessionId?: string;
    agentTurnId?: string;
    agentToolUseId?: string;
    agentFailure?: AgentLifecycleSignal['agentFailure'];
}

/**
 * Closed reasons a provider process ended. Each one maps to a Chat failure or an orderly stop.
 */
export type ChatProcessEnd =
    | { reason: 'closed' }
    | { reason: 'spawnFailed'; code?: string }
    | { reason: 'exited'; exitCode: number | null; signal: NodeJS.Signals | null }
    | { reason: 'frameTooLarge' }
    | { reason: 'writeFailed' };

/**
 * Closed outcome of one provider process lifetime, for the content-free exit log.
 */
export interface AgentChatExit {
    end: ChatProcessEnd;
    requested: boolean;
    /**
     * The turn that was running when the process ended, if any; an unrequested end fails it.
     */
    activeTurnId?: string;
    turns: number;
    serverRequests: number;
    rejectedRequests: number;
    droppedFrames: number;
}

/**
 * Start failure carrying a closed reason. `detail` is Caxri-authored copy only.
 */
export class AgentChatStartError extends Error {
    constructor(
        readonly reason: AgentChatFailureReason,
        readonly detail?: string,
    ) {
        super(detail ?? reason);
    }
}

/**
 * Bounded tail of an Agent Session's transcript. `truncated` is true when older records were cut off.
 */
export interface AgentChatTranscript {
    content: string;
    truncated: boolean;
}

export type AgentChatResponse =
    | { kind: 'decision'; decision: AgentChatDecision }
    | { kind: 'answers'; answers: Record<string, string[]> };

/**
 * Test seam for a fake provider child. Always called with piped stdio.
 */
export type SpawnChatProcess = (
    executable: string,
    arguments_: string[],
    options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

/**
 * Everything a provider session may read or report. Callbacks are fenced by the service: once a session is replaced or
 * closed, its late reports are dropped.
 */
export interface AgentChatSessionHost {
    terminalId: string;
    cwd: string;
    executable: string;
    environment: NodeJS.ProcessEnv;
    /**
     * The provider's TUI launch settings; each driver translates the options that have a structured equivalent.
     */
    launch: AgentLaunchSettings;
    /**
     * A real-Agent E2E run authorized this Chat; the driver ignores `launch` for its fixed, narrowest configuration.
     */
    isRealAgentE2E: boolean;
    /**
     * Agent Session to resume. Absent for a Chat that has never started a turn.
     */
    agentSessionId?: string;
    clientVersion: string;
    spawnProcess?: SpawnChatProcess;
    read(): AgentChatSnapshot;
    apply(operations: AgentChatPatchOperation[]): void;
    /**
     * Changes one task's own projection (a subagent's conversation or a shell's output). Task metadata itself lives in
     * the parent snapshot's `tasks` and changes through `apply`.
     */
    applyTask(taskId: string, operations: AgentChatTaskPatchOperation[]): void;
    /**
     * The task projection Server Core holds, or `undefined` when none was created yet.
     */
    readTask(taskId: string): AgentChatTaskSnapshot | undefined;
    lifecycle(event: ChatLifecycleEvent): void;
    /**
     * Binds an Agent Session to the Terminal. Called only once the provider has durably recorded it (its first turn
     * started), because binding earlier would leave an identity that can never be resumed.
     */
    onSessionBound(agentSessionId: string): void;
    onTurnFinished(status: AgentChatTurn['status'], durationMs: number | undefined): void;
    onProtocolRejected(reason: 'unsupportedRequest' | 'unkeyedRequest', method: string): void;
    onExit(exit: AgentChatExit): void;
    /**
     * Bounded tail of the bound Agent Session's on-disk transcript, for a provider whose resume does not return history
     * itself. `undefined` when the transcript is missing or unreadable.
     */
    readTranscript(): Promise<AgentChatTranscript | undefined>;
}

/**
 * How an input reached the provider when it did not simply start a turn: `steered` into the running turn, or `queued`
 * by Server Core and sent once the previous turn ended. The provider records it on the user message.
 */
export interface ChatInputOptions {
    delivery?: 'queued' | 'steered';
}

/**
 * History of a task the live session no longer holds (a previous process, a resumed conversation).
 */
export interface ChatTaskHistory {
    /**
     * The task's stable id, which may differ from the id the Client asked for (a timeline item id).
     */
    taskId: string;
    operations: AgentChatTaskPatchOperation[];
}

/**
 * One live provider process bound to one Chat Terminal.
 */
export interface AgentChatProviderSession {
    readonly isOpen: boolean;
    /**
     * Spawns the provider and opens or resumes its conversation. Resolves once the Chat can accept input; rejects with
     * {@link AgentChatStartError}.
     */
    start(): Promise<'resumed' | 'started'>;
    /**
     * Starts a turn, or steers the running one. Image data goes only to the provider; the projection keeps thumbnails.
     * The service decides between queueing and steering; a session never queues on its own.
     */
    send(
        message: Omit<AgentChatMessageInput, 'delivery'>,
        options?: ChatInputOptions,
    ): Promise<void>;
    /**
     * Runs one of the commands this session reported in the snapshot's `commands`; the service has already checked that
     * `name` is listed and that no turn is running.
     */
    runCommand(
        name: string,
        arguments_: string | undefined,
        options?: ChatInputOptions,
    ): Promise<void>;
    /**
     * Switches the model or effort for the next turn onward. The service has already validated the change against the
     * snapshot's `models`; the session reports the new `model` and `effort` once the provider accepts them.
     */
    configure(config: AgentChatModelChange): Promise<void>;
    /**
     * Stops the running turn. Background tasks keep running.
     */
    interrupt(): Promise<void>;
    /**
     * Stops one task listed in the snapshot's `tasks`. Fails with `CONFLICT` when the task is no longer running.
     */
    stopTask(taskId: string): Promise<void>;
    /**
     * Rebuilds a task the session holds no projection for from the provider's own record. `taskId` is a task id or the
     * id of the timeline item that started the task. Resolves `undefined` when the provider does not know it.
     */
    readTaskHistory(taskId: string): Promise<ChatTaskHistory | undefined>;
    respond(requestId: string, response: AgentChatResponse): void;
    /**
     * Orderly stop requested by Caxri. The provider's record is already durable, so nothing is lost.
     */
    close(): Promise<void>;
}

export interface AgentChatDriver {
    create(host: AgentChatSessionHost): AgentChatProviderSession;
}

/**
 * One input the service delivers to a started provider session, in the order the Client sent it.
 */
export type ChatInputDelivery = (session: AgentChatProviderSession) => Promise<void>;
