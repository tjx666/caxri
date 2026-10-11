import type { AgentDelegationReceipt, TerminalRecord } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { CaxriDatabase } from '../db';
import type { CommanderCompletionNotifier } from './completion-notice';
import { commanderLaunchArguments } from './launch';
import { recordCommanderDelegation } from './tasks';

/**
 * The Commander's hooks into the Terminal manager and the delegation service. The composition root hands them over
 * before the notifier exists, because the notifier fences its writes through that same Terminal manager; `notifier` is
 * bound once it does.
 */
export class CommanderTerminalHooks {
    notifier: CommanderCompletionNotifier | undefined;

    readonly launchArguments = (terminal: TerminalRecord): string[] => {
        const commander = this.database.agentCommanderRows();
        return commanderLaunchArguments(terminal, {
            terminalId: commander?.terminalId,
            workspacePath: commander && this.database.getProject(commander.projectId)?.rootPath,
        });
    };

    readonly launchPrompt = (terminal: TerminalRecord): string | undefined =>
        this.notifier?.launchPrompt(terminal.id);

    /**
     * Records a task for an unregistered Commander delegation before queuing its notice, so the ledger row exists by
     * the time the Commander reads the notice.
     */
    readonly receiptChanged = (
        receipt: AgentDelegationReceipt,
        previous: AgentDelegationReceipt | undefined,
    ): void => {
        recordCommanderDelegation(this.database, receipt, previous, Date.now(), this.logger);
        this.notifier?.notifyReceiptChanged(receipt, previous);
    };

    constructor(
        private readonly database: Parameters<typeof recordCommanderDelegation>[0] &
            Pick<CaxriDatabase, 'getProject'>,
        private readonly logger: StructuredLogger,
    ) {}

    launched(terminalId: string, didLaunchAgent: boolean): void {
        this.notifier?.onLaunched(terminalId, didLaunchAgent);
    }
}
