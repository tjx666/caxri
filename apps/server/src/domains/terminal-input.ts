import type { ServerEvent } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
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
    return async ({ terminalId, data, requireRunningAgent }, abortSignal) => {
        const terminal = options.database.getTerminal(terminalId);
        assertE2EAgentInputFromEnvironment(terminal?.provider);
        /**
         * A batch submit must never fall through to the shell after its Agent exits.
         */
        const agentLaunchId = requireRunningAgent
            ? options.terminals.agentLaunchId(terminalId)
            : undefined;
        if (requireRunningAgent && !agentLaunchId)
            throw new CaxriError('CONFLICT', 'Managed Agent is no longer running');
        const accepted = agentLaunchId
            ? options.terminals.writeAgentExact(terminalId, data, agentLaunchId)
            : await options.terminals.writeAcknowledged(terminalId, data, abortSignal);
        if (requireRunningAgent && !accepted)
            throw new CaxriError('CONFLICT', 'Managed Agent changed before review input');
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

/**
 * Mouse reports are byte strings from xterm, not submitted text. Keep them out of Session Activity and preserve their
 * values until Terminal Host writes a Buffer to the PTY.
 */
export function createTerminalBinaryInputHandler(
    options: TerminalInputHandlerOptions,
): DomainHandlers['terminal.inputBinary'] {
    return async ({ terminalId, data, expectedAgentLaunchId }, abortSignal) => {
        const terminal = options.database.getTerminal(terminalId);
        assertE2EAgentInputFromEnvironment(terminal?.provider);
        const accepted = expectedAgentLaunchId
            ? options.terminals.writeAgentExact(
                  terminalId,
                  data,
                  expectedAgentLaunchId,
                  'human',
                  undefined,
                  'binary',
              )
            : await options.terminals.writeAcknowledged(terminalId, data, abortSignal, 'binary');
        if (!accepted) throw new CaxriError('CONFLICT', 'Terminal changed before binary input');
        return null;
    };
}

/**
 * Prevents an asynchronous long-paste replacement from crossing into a new Agent generation.
 */
export function createTerminalAgentExactInputHandler(
    options: TerminalInputHandlerOptions,
): DomainHandlers['terminal.inputAgentExact'] {
    return ({ terminalId, data, expectedAgentLaunchId }) => {
        const terminal = options.database.getTerminal(terminalId);
        assertE2EAgentInputFromEnvironment(terminal?.provider);
        if (!options.terminals.writeAgentExact(terminalId, data, expectedAgentLaunchId))
            throw new CaxriError('CONFLICT', 'Managed Agent changed before long paste insertion');
        return null;
    };
}
