import type {
    AgentDelegationReceipt,
    AgentDelegationSettings,
    AgentLaunchSettings,
    AgentProvider,
    CommanderHandoverTarget,
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
     * Terminal record change beside them, yet the Agent Commander board shows both fields. Saves that only advance
     * internal bookkeeping (transcript offsets, input epochs, fencing marks) stay silent, so a busy collector does not
     * flood the event journal. `previous` is the stored receipt before this save, absent for a newly created task.
     */
    onReceiptChanged?(receipt: AgentDelegationReceipt, previous?: AgentDelegationReceipt): void;
    /**
     * The Agent Commander's own Sessions, for a `newSession` delegation. Optional so a unit test can omit the
     * Commander.
     */
    commanderSessions?: {
        /**
         * Creates an empty Commander Session in a visible top-level Project and returns its ID. A title names it
         * manually, so automatic naming never replaces it.
         */
        create(projectId: string, title?: string): string;
        /**
         * Removes a Commander Session the delegation just created but never used. Metadata only.
         */
        discard(sessionId: string): void;
    };
    /**
     * The hand-overs the user gave the Agent Commander, for a `continueFromHandover` delegation. Optional so a unit
     * test can omit the Commander.
     */
    commanderHandovers?: {
        /**
         * The conversation an unconsumed hand-over of this Session lets the Commander continue; throws when there is
         * none.
         */
        target(handoverId: string, sessionId: string): CommanderHandoverTarget;
        /**
         * True while the handed-over Agent is in a turn or waiting on the user.
         */
        isBusy(sessionId: string, terminalId: string): boolean;
        /**
         * Marks the hand-over continued by this delegation and links its task, before the receipt is announced.
         */
        consume(handoverId: string, delegationId: string): void;
    };
    submissionTimeoutMs?: number;
    now?: () => number;
}
