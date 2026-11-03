import type {
    AgentDelegationProgress,
    AgentDelegationReceipt,
    AgentDelegationSettings,
    AgentLaunchSettings,
    AgentProvider,
    BotHandoverTarget,
    SessionRelation,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { AgentDispatchService } from '../agent-dispatch';
import type { CaxriDatabase } from '../db';
import type { DelegationTranscriptReader } from './collection';
import type { DelegationLimitFailure } from './receipt-timing';

/**
 * Everything the delegation service borrows from the rest of the Server. Terminal reads and writes stay optional so a
 * test or a headless caller can construct the service without a Terminal host.
 */
/**
 * A worktree Project made for a new Session, which `create` binds the Session to.
 */
export interface DelegationWorktree {
    identity: { device: string; inode: string };
    projectId: string;
}

export interface AgentDelegationServiceOptions extends DelegationTranscriptReader {
    database: CaxriDatabase;
    dispatch: Pick<AgentDispatchService, 'start'> & Partial<Pick<AgentDispatchService, 'resume'>>;
    userDataPath: string;
    /**
     * Optional for the same reason the Terminal callbacks are: a unit test constructs this service without the Server
     * around it. The composed Server always passes one, so a real refused admission is always recorded.
     */
    logger?: StructuredLogger;
    launchSettings(provider: AgentProvider): AgentLaunchSettings;
    delegationSettings?(): AgentDelegationSettings;
    verifyLaunch(launch: AgentLaunchSettings, provider: AgentProvider): Promise<void>;
    dimensions?(terminalId: string): { cols: number; rows: number } | undefined;
    /**
     * Whether `session.openAgentsInChat` is on and Agent Chat is available, so an eligible child opens as a Chat; see
     * `delegationChildLaunch`.
     */
    opensAgentsInChat?(): boolean;
    /**
     * Whether the user turned `provider`'s lifecycle hooks on in settings. A visible PTY child needs them to correlate
     * its task, so a child whose provider has them off fails as `hooks_required` before anything launches. This reads
     * the configured setting, the same condition that makes the hook manager ignore a provider's signals, not install
     * health: a reconcile in progress or a drifted config file still delivers signals through the launch token.
     * Optional so a unit test can construct this service without the hook manager.
     */
    hasLifecycleHooks?: (provider: AgentProvider) => boolean;
    /**
     * Whether a Terminal runs its Agent as a Chat. A property, so restart recovery can take it unbound.
     */
    isChatTerminal?: (terminalId: string) => boolean;
    /**
     * Whether a Chat Terminal's provider is live, including while it starts or is being suspended (when
     * `currentLaunchId` has no launch yet or any more).
     */
    isChatLive?(terminalId: string): boolean;
    inputEpoch?(terminalId: string): number;
    currentLaunchId?(terminalId: string): string | undefined;
    isIdle?(terminalId: string, launchId: string, turnId: string): boolean;
    /**
     * The Agent Endpoint generation currently live in a Terminal, or `undefined` when none is active. A retry
     * (`agent.delegation.retry`) runs as the Agent that delegated the task, which can read the new task only while its
     * stored principal still names this exact generation. Absent means no generation can be proven, so a retry as an
     * Agent is refused (`caller_gone`).
     */
    callerEndpoint?(terminalId: string): { endpointId: string; generation: number } | undefined;
    /**
     * Writes to one exact Agent launch. The return value is the synchronous admission; for a Terminal with no Renderer
     * attachment that answer is provisional, and `onDelivered` reports what the Terminal Host actually did.
     */
    write?(
        terminalId: string,
        launchId: string,
        data: string,
        onDelivered?: (wasAccepted: boolean) => void,
    ): boolean;
    /**
     * Called after a task is created or its `status` or `failure` changes. Many of those transitions come from this
     * service alone (a startup deadline, an asynchronous result collection, a rejected follow-up) with no Session or
     * Terminal record change beside them, yet Caxri Bot's board shows both fields. Saves that only advance internal
     * bookkeeping (transcript offsets, input epochs, fencing marks) stay silent, so a busy collector does not flood the
     * event journal. `previous` is the stored receipt before this save, absent for a newly created task.
     */
    onReceiptChanged?(receipt: AgentDelegationReceipt, previous?: AgentDelegationReceipt): void;
    /**
     * When the provider's own usage limit that failed a task resets (epoch milliseconds), or `undefined` when no
     * authoritative source knows: the failing Chat turn's limit notice, or the weekly usage guard of the provider.
     * Asked once, as a task moves into a `quota_exhausted` or `rate_limited` failure; the answer becomes
     * `failureResetsAt`. It must not estimate: an unknown reset time stays absent.
     */
    limitResetsAt?(failure: DelegationLimitFailure): number | undefined;
    /**
     * What an active Agent Chat Session is doing now, as one short label, or `undefined` for a Terminal Session and for
     * a Chat between steps. Read by `agent.delegation.sessions` and by the progress events.
     */
    chatStep?(terminalId: string): string | undefined;
    /**
     * The turn an Agent Chat Terminal is in now, or `undefined` for a Terminal that is not a Chat and for a Chat
     * between turns. Read once, when a task is created, so the caller's timeline can place the delegation in the turn
     * that made it; the ID is stored and never logged.
     */
    callerTurnId?(terminalId: string): string | undefined;
    /**
     * Called, at most once per second per task, when an active Chat Session's step changed. The step is private domain
     * data: the callee must not log it.
     */
    onProgress?(progress: AgentDelegationProgress): void;
    /**
     * The Sessions a `newSession` delegation creates. Optional so a unit test can omit them.
     */
    newSessions?: {
        /**
         * Creates an empty Session in a visible top-level Project and returns its ID. A title names it manually, so
         * automatic naming never replaces it. Caxri Bot's Session is also recorded as its own, which is what admits its
         * later delegations there. `createdBySessionId` is an ordinary Agent caller's own Session, recorded as the new
         * Session's creator, and `createdByRelation` how that caller started it. Caxri Bot's Sessions carry neither
         * from this path.
         */
        create(
            projectId: string,
            title: string | undefined,
            isBot: boolean,
            createdBySessionId?: string,
            createdByRelation?: SessionRelation,
            worktree?: DelegationWorktree,
        ): string;
        /**
         * Creates a linked worktree of the Project on a new branch, before any Session exists, so a failed Git step
         * leaves nothing behind. Rejects when the Project is not a visible top-level one. Optional so a unit test can
         * omit it.
         */
        prepareWorktree?(projectId: string, branch: string): Promise<DelegationWorktree>;
        /**
         * Removes a Session the delegation just created but never used. Metadata only.
         */
        discard(sessionId: string): void;
    };
    /**
     * The hand-overs the user gave Caxri Bot, for a `continueFromHandover` delegation. Optional so a unit test can omit
     * Caxri Bot.
     */
    botHandovers?: {
        /**
         * The conversation an unconsumed hand-over of this Session lets Caxri Bot continue; throws when there is none.
         */
        target(handoverId: string, sessionId: string): BotHandoverTarget;
        /**
         * True while the handed-over Agent is in a turn or waiting on the user.
         */
        isBusy(sessionId: string, terminalId: string): boolean;
        /**
         * Marks the hand-over continued by this delegation and links its task, before the receipt is announced.
         */
        consume(handoverId: string, delegationId: string): void;
        /**
         * Undoes `consume` by this delegation when its continuation was refused before anything reached the
         * conversation, so Caxri Bot can retry the hand-over.
         */
        release(handoverId: string, delegationId: string): void;
    };
    submissionTimeoutMs?: number;
    now?: () => number;
}
