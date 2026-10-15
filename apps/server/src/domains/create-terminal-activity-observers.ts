import type { AgentDelegationService } from './agent-delegation';
import type { AgentCoordinator, CompactionReadiness } from './agents';
import type { CommanderTerminalHooks } from './commander';
import type { TerminalManagerOptions, TerminalSuspensionService } from './terminal';

/**
 * Keep maintenance I/O observable without attributing it to the user. Service holders are read on each input because
 * TerminalManager is constructed before suspension and delegation services.
 */
export function createTerminalActivityObservers(
    readiness: Pick<CompactionReadiness, 'input'>,
    suspension: { service?: Pick<TerminalSuspensionService, 'observeInput'> },
    commander: Pick<CommanderTerminalHooks, 'input'>,
    delegation: { service?: Pick<AgentDelegationService, 'interruptTerminal'> },
    coordinator: Pick<AgentCoordinator, 'observeOutput'>,
): Pick<TerminalManagerOptions, 'onInput' | 'onOutputActivity'> {
    return {
        onInput: (terminalId, data, origin) => {
            readiness.input(terminalId, data);
            if (origin === 'human') {
                suspension.service?.observeInput(terminalId, data);
                commander.input(terminalId, data);
                delegation.service?.interruptTerminal(terminalId, true);
            }
        },
        onOutputActivity: (terminalId, processId) =>
            coordinator.observeOutput(terminalId, processId),
    };
}
