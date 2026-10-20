import type { AgentDelegationReceipt } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type {
    AgentCommanderRowReader,
    CaxriDatabase,
    CommanderPendingNoticesModel,
    DeliveredNotice,
} from '../db';
import type { CommanderCompletionNoticeStatus } from './notice-text';
import type { QueuedNoticeBatch } from './queued-notices';

/**
 * Why a consumed notice batch's PTY write did not provably land. Both are rare: the Commander Terminal was just
 * confirmed idle and on its current generation a moment earlier in the same synchronous call.
 */
export type CommanderCompletionNoticeDeliveryFailure = 'rejected' | 'unconfirmed';

/**
 * Which delivery gate is holding the pending notices back. Logged once per change for the current batch, so a report
 * that the Commander "never heard back" names the gate without logging every lifecycle signal.
 */
export type CommanderCompletionNoticeDeferral =
    /**
     * The Terminal the notice would go to is not the recorded Commander Terminal.
     */
    | 'not_commander_terminal'
    /**
     * No finished turn is proven idle yet: the Commander is mid-turn, or its last turn was already used by a notice.
     */
    | 'commander_busy'
    /**
     * The finished turn has no recorded start, or started on another launch.
     */
    | 'turn_baseline_missing'
    /**
     * Someone typed into the Commander since its turn started and did not submit it; delivering would press Enter on
     * their draft.
     */
    | 'draft_input'
    /**
     * The Commander is waiting on a permission prompt.
     */
    | 'awaiting_permission';

/**
 * Classifies a delegation receipt into the notice it should raise, or `undefined` when the transition is not one the
 * Commander needs pushed to it (an in-flight status, a human takeover, or an interrupted/stopped task the Commander
 * itself did not ask to stop through a follow-up).
 */
export function classifyCommanderCompletionNotice(
    receipt: Pick<AgentDelegationReceipt, 'failure' | 'status'>,
): CommanderCompletionNoticeStatus | undefined {
    if (receipt.status === 'completed') return 'completed';
    if (receipt.status === 'failed' || receipt.status === 'answer_unavailable') return 'failed';
    if (
        receipt.status === 'blocked' &&
        (receipt.failure === 'startup_waiting' || receipt.failure === 'permission_required')
    )
        return 'needsInput';
    return undefined;
}

export interface CommanderCompletionNotifierOptions {
    /**
     * `agentCommanderRows` filters every created Session and is reserved for receipts that need that list; every other
     * path identifies the Commander Terminal through the constant-time `agentCommanderTerminal` reader.
     */
    database: Pick<CaxriDatabase, 'agentCommanderRows' | 'getSession'> &
        AgentCommanderRowReader & {
            commanderPendingNotices: Pick<
                CommanderPendingNoticesModel,
                'clearTurn' | 'list' | 'markTurnStarted' | 'putDelegation' | 'removeDelegations'
            >;
        };
    /**
     * The same idle proof delegation follow-ups fence resume against (`AgentCoordinator.hasIdleProof`,
     * `apps/server/src/domains/agent-delegation/service.ts`). Proves the exact launch and turn actually finished; it
     * says nothing about a later draft, which the input-epoch check below covers.
     */
    hasIdleProof(terminalId: string, launchId: string, turnId: string): boolean;
    /**
     * `TerminalManager.inputEpoch`: bumps once per human keystroke written to the Terminal, but not for this module's
     * own injected write (see `write` below). Comparing it to the value captured at the finished turn's start is the
     * same fence `AgentDelegationService` uses before a follow-up resumes (`service.ts` ~260-300).
     */
    inputEpoch(terminalId: string): number;
    logger?: StructuredLogger;
    now?: () => number;
    /**
     * How long managed-Session state changes wait before they may go out: until no Session changed for `quietMs`, and
     * never longer than `maxWaitMs` after the first. Production uses five and thirty seconds; tests may shorten them.
     */
    sessionNoticeTiming?: { quietMs: number; maxWaitMs: number };
    /**
     * Delivers and submits one notice line, given without a line terminator. A PTY Commander gets a paste and an Enter,
     * as fenced exact-launch writes with `origin: 'delegation'` (`TerminalManager.writeAgentExact`) so the line never
     * bumps the input epoch a later notice's fence reads; a Chat Commander gets a Chat message.
     */
    write(
        terminalId: string,
        data: string,
        launchId: string,
        onDelivered?: (wasAccepted: boolean) => void,
    ): boolean;
}

/**
 * What the launch prompt built for one Commander launch carried, settled once that launch is running.
 */
export interface CommanderLaunchPromptClaim {
    /**
     * When the prompt was built. A turn marker set after it belongs to the new launch, not the one this prompt resumed.
     */
    claimedAt: number;
    /**
     * The exact revisions the prompt reported; a newer transition that lands before the launch runs stays owed.
     */
    delegations: DeliveredNotice[];
    hasInterruptedTurn: boolean;
    /**
     * The in-memory notices the prompt reported; one replaced by a later event before the launch runs stays owed.
     */
    queued: QueuedNoticeBatch;
    oldestQueuedAt: number;
    terminalId: string;
}
