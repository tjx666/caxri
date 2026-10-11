import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';

import type {
    AgentChatDecision,
    AgentChatFailureReason,
    AgentChatMessageInput,
    AgentChatModelChange,
    AgentChatPatchOperation,
    AgentChatPermission,
    AgentChatSnapshot,
    AgentChatTaskPatchOperation,
    AgentChatTaskSnapshot,
    AgentChatTurn,
    AgentLaunchSettings,
} from '@caxri/protocol';
import { CaxriError, isCaxriError } from '@caxri/protocol';

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

interface ChatLifecycleEvent {
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
 * An input whose request timed out and whose arrival the provider could not confirm: it may have started a turn that is
 * still on its way, so it must not be sent again automatically. `details.deliveryUnknown` marks it across the wire.
 */
export function deliveryUnknownError(label: string): CaxriError {
    return new CaxriError(
        'TIMEOUT',
        `${label} did not confirm this message in time. It may still have been sent, so check the conversation before sending it again.`,
        { deliveryUnknown: true },
    );
}

export function isDeliveryUnknown(error: unknown): boolean {
    return isCaxriError(error) && error.details?.deliveryUnknown === true;
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
     * The permission level and plan mode the Chat chose. A level the provider does not offer, or none, leaves `launch`
     * to decide. The driver reports what it runs with as the snapshot's `permissionMode` and `planMode`.
     */
    permission: AgentChatPermission;
    /**
     * Agent Session to resume. Absent for a Chat that has never started a turn.
     */
    agentSessionId?: string;
    /**
     * Where the resumed conversation ends, set only for the restart that follows a rewind whose provider rewinds by
     * resuming at an earlier point of its record (see {@link ChatResumePoint}).
     */
    resumeAt?: string;
    clientVersion: string;
    spawnProcess?: SpawnChatProcess;
    /**
     * Bound on a request that starts or steers a turn. Tests shorten it to exercise a provider that answers late.
     */
    turnRequestTimeoutMs?: number;
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
    /**
     * The provider changed the Chat's permission on its own (Claude Code leaving plan mode once its plan is approved),
     * so the service saves it as the Chat's choice.
     */
    onPermissionChanged(permission: AgentChatPermission): void;
    onProtocolRejected(reason: 'unsupportedRequest' | 'unkeyedRequest', method: string): void;
    /**
     * A turn request timed out and the session checked whether the provider recorded the input anyway.
     */
    onDeliveryChecked(method: string, outcome: 'delivered' | 'unknown'): void;
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
 * Where "Fork from here" cuts: just before the user message that started `turnId`, so the fork holds the turns before
 * it.
 */
export interface ChatForkTarget {
    itemId: string;
    turnId: string;
    /**
     * The message's text, which a provider can match against its own record before it changes anything.
     */
    text: string;
    /**
     * Turns older than `turnId` that the projection holds; a provider record may hold more.
     */
    keptTurns: number;
    removedTurns: number;
}

/**
 * What "Edit from here" rewinds: the user message that started `turnId`, which goes away with that turn and the
 * `removedTurns - 1` turns after it.
 */
export interface ChatRewindTarget extends ChatForkTarget {
    restoreFiles: boolean;
}

/**
 * How the restart after a rewind reopens the conversation. Absent: resume the bound Agent Session as usual (the
 * provider already rewound its record). `resumeAt`: resume it ending at that point of the record. `fresh`: the rewind
 * removed every turn, so the restart begins a new Agent Session.
 */
export type ChatResumePoint = { kind: 'resumeAt'; at: string } | { kind: 'fresh' };

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
     * snapshot's `models`; the session reports the new `model` and `effort` once the provider accepts them. A provider
     * that lists no models (Grok Build) omits it: validation already rejects every switch it could receive.
     */
    configure?(config: AgentChatModelChange): Promise<void>;
    /**
     * Applies a validated permission level and plan mode to the live provider, for the next turn onward; a running turn
     * keeps its own where the provider allows. A provider that fixes them at launch (Grok Build) omits it, and the
     * service restarts it on the same conversation instead.
     */
    setPermission?(permission: AgentChatPermission): Promise<void>;
    /**
     * Rewinds the provider's own record to just before `target`, restoring files first when asked. The service has
     * already checked that no turn runs and that the provider offers file restore; it restarts the session afterwards,
     * so the projection is rebuilt from the rewound record rather than patched here. Fails without changing anything
     * when the provider refuses, as far as the provider allows.
     */
    rewind(target: ChatRewindTarget): Promise<ChatResumePoint | undefined>;
    /**
     * "Fork from here": copies the provider's own record up to just before `target` into a new Agent Session and
     * returns its id, or `undefined` when nothing comes before it and the new Chat starts a conversation of its own.
     * Leaves this conversation unchanged. The service has already checked that no turn runs, and forks the first
     * message of a whole conversation without asking the provider.
     */
    fork(target: ChatForkTarget): Promise<string | undefined>;
    /**
     * "Restore code to here": restores the files changed since `target` from the provider's file checkpoints and keeps
     * the conversation. The service has already checked that no turn runs and that the provider offers file restore
     * (`capabilities.chatRewindFiles`); a provider without them omits it.
     */
    restoreFiles?(target: ChatRewindTarget): Promise<void>;
    /**
     * Stops the running turn. Background tasks keep running.
     */
    interrupt(): Promise<void>;
    /**
     * Re-reads the provider's own record of running background work and corrects the snapshot's `tasks` where it
     * drifted. Providers whose task list cannot drift (it is pushed with every change) omit it.
     */
    refreshTasks?(): Promise<void>;
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
