import type {
    AgentDelegationReceipt,
    AgentDelegationSettings,
    AgentLaunchSettings,
    AgentProvider,
    BotHandoverTarget,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { AgentDispatchService } from '../agent-dispatch';
import type { CaxriDatabase } from '../db';
import type { DelegationTranscriptReader } from './collection';

/**
 * Everything the delegation service borrows from the rest of the Server. Terminal reads and writes stay optional so a
 * test or a headless caller can construct the service without a Terminal host.
 */
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
     * The Sessions a `newSession` delegation creates. Optional so a unit test can omit them.
     */
    newSessions?: {
        /**
         * Creates an empty Session in a visible top-level Project and returns its ID. A title names it manually, so
         * automatic naming never replaces it. Caxri Bot's Session is also recorded as its own, which is what admits its
         * later delegations there. `createdBySessionId` is an ordinary Agent caller's own Session, recorded as the new
         * Session's creator.
         */
        create(
            projectId: string,
            title: string | undefined,
            isBot: boolean,
            createdBySessionId?: string,
        ): string;
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
