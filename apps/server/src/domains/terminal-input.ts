import type { ServerEvent } from '@caxri/protocol';
import { assertE2EAgentInputFromEnvironment } from '@caxri/system';

import type { AgentCoordinator } from './agents';
import type { CaxriDatabase } from './db';
import type { DomainHandlers } from './domain-services';
import type { TerminalManager } from './terminal';

interface TerminalInputHandlerOptions {
    coordinator: AgentCoordinator;
    database: CaxriDatabase;
    send(event: ServerEvent): void;
    terminals: TerminalManager;
}

/**
 * Keeps raw PTY traffic out of persistence while turning only a successfully submitted, non-empty line into
 * content-free Session Activity. Bracketed-paste line endings remain editor input until a later submit.
 */
export function createTerminalInputHandler(
    options: TerminalInputHandlerOptions,
): DomainHandlers['terminal.input'] {
    return async ({ terminalId, data }, abortSignal) => {
        const terminal = options.database.getTerminal(terminalId);
        assertE2EAgentInputFromEnvironment(terminal?.provider);
        const accepted = await options.terminals.writeAcknowledged(terminalId, data, abortSignal);
        const didSubmit =
            accepted &&
            options.terminals.processId(terminalId) !== undefined &&
            options.coordinator.observeInput(terminalId, data);
        if (
            didSubmit &&
            terminal &&
            options.database.touchSessionActivity(terminal.sessionId, 'user_submission')
        )
            options.send({
                event: 'state.changed',
                payload: {
                    kind: 'records',
                    sessionIds: [terminal.sessionId],
                    terminalIds: [],
                },
            });
        return null;
    };
}
