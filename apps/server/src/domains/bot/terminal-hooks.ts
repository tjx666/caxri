import type { AgentDelegationReceipt, TerminalRecord } from '@caxri/protocol';
import { errorMessage } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { AgentLifecycleSignal, SessionActivityTransition } from '../agents';
import type { CaxriDatabase } from '../db';
import type { BotCompletionNotifier } from './completion-notice';
import type { BotHandoverService } from './handover';
import { botLaunchArguments } from './launch';
import { recordBotDelegation } from './tasks';

/**
 * Caxri Bot's hooks into the Terminal manager and the delegation service. The composition root hands them over before
 * the notifier exists, because the notifier fences its writes through that same Terminal manager; `notifier` is bound
 * once it does.
 */
export class BotTerminalHooks {
    notifier: BotCompletionNotifier | undefined;
    handovers: BotHandoverService | undefined;

    /**
     * Human input into any Terminal: the notifier's draft fence, and taking back a handed-over Session whose Agent the
     * user typed into.
     */
    readonly input = (terminalId: string, data: string): void => {
        this.notifier?.observeInput(terminalId, data);
        this.handovers?.observeInput(terminalId);
    };

    /**
     * An Agent Endpoint `SIGINT` interrupted the Agent in a Terminal (the keyboard Escape arrives through
     * {@link input}).
     */
    readonly interrupted = (terminalId: string): void =>
        this.notifier?.observeInterrupt(terminalId);

    /**
     * Human input into a Chat (a message, command, rewind, or interrupt), the Chat counterpart of {@link input}: it
     * takes a handed-over Session back. A Chat has no Terminal draft for the notifier to fence.
     */
    readonly chatInput = (terminalId: string): void => this.handovers?.observeInput(terminalId);

    /**
     * Every lifecycle signal Server Core applied: the notifier's turn tracking and a hand-over waiting for its turn.
     */
    readonly lifecycleApplied = (signal: AgentLifecycleSignal): void => {
        this.notifier?.onLifecycleApplied(signal);
        this.handovers?.onLifecycleApplied(signal);
    };

    /**
     * Any Session's activity state changed; the notifier keeps those of the Sessions Caxri Bot manages.
     */
    readonly sessionActivityChanged = (transition: SessionActivityTransition): void =>
        this.notifier?.notifySessionActivity(transition);

    readonly launchArguments = (terminal: TerminalRecord): string[] => {
        const bot = this.database.caxriBotRows();
        return botLaunchArguments(terminal, {
            terminalId: bot?.terminalId,
            workspacePath: bot && this.database.getProject(bot.projectId)?.rootPath,
        });
    };

    /**
     * The Chat equivalent of `launchPrompt`: a Chat Caxri Bot takes what it missed as its first message once ready.
     */
    readonly chatReady = (terminalId: string): void => this.notifier?.onChatReady(terminalId);

    readonly launchPrompt = (terminal: TerminalRecord): string | undefined =>
        this.notifier?.launchPrompt(terminal.id);

    /**
     * Records a task for an unregistered Caxri Bot delegation before queuing its notice, so the ledger row exists by
     * the time Caxri Bot reads the notice.
     */
    readonly receiptChanged = (
        receipt: AgentDelegationReceipt,
        previous: AgentDelegationReceipt | undefined,
    ): void => {
        /**
         * This runs inside delegation creation, after its row is stored. The ledger is bookkeeping, so a failure here
         * is logged and must not fail the delegation itself.
         */
        try {
            recordBotDelegation(this.database, receipt, previous, Date.now(), this.logger);
        } catch (error) {
            this.logger.write('warn', logEventCatalog.caxriBot.taskRecordFailed, {
                fields: {
                    delegationId: receipt.delegationId,
                    error: errorMessage(error, 'unknown'),
                },
            });
        }
        this.notifier?.notifyReceiptChanged(receipt, previous);
    };

    constructor(
        private readonly database: Parameters<typeof recordBotDelegation>[0] &
            Pick<CaxriDatabase, 'getProject'>,
        private readonly logger: StructuredLogger,
    ) {}

    launched(terminalId: string, agentLaunchId: string | undefined): void {
        this.notifier?.onLaunched(terminalId, agentLaunchId);
    }
}
