import type { StructuredLogger } from '@caxri/system';

import type { AgentCommanderRowReader, CaxriDatabase, CommanderPendingNoticesModel } from '../db';

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
