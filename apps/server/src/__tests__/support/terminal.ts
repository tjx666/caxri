import type { ServerEvent } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { omit } from 'es-toolkit';

import type { TerminalExecutionPort, TerminalManagerOptions } from '../../domains/terminal';
import { TerminalManager } from '../../domains/terminal';
import type { TerminalStateStore } from '../../domains/terminal/state-store';
import type { LocalTerminalExecutionOptions } from '../../terminal-host/local-execution';
import { LocalTerminalExecution } from '../../terminal-host/local-execution';

export type TestTerminalManagerOptions = Omit<TerminalManagerOptions, 'execution'> &
    Omit<LocalTerminalExecutionOptions, 'logger' | 'currentProvider'> & {
        execution?: TerminalExecutionPort;
    };

export function createTestTerminalExecution(
    logger: StructuredLogger,
    options: TestTerminalManagerOptions = {},
    currentProvider?: LocalTerminalExecutionOptions['currentProvider'],
): TerminalExecutionPort {
    return (
        options.execution ??
        new LocalTerminalExecution({
            agentOutputRecoverySettings: options.agentOutputRecoverySettings,
            currentProvider,
            logger,
            outputFlushMs: options.outputFlushMs,
            sampleResources: options.sampleResources,
            spawn: options.spawn,
            terminalColors: options.terminalColors,
        })
    );
}

/**
 * Keeps the in-process execution adapter reachable only from tests; production Terminal coordination requires an
 * explicit process-backed port from Server Core.
 */
export function createTestTerminalManager(
    database: TerminalStateStore,
    emit: (event: ServerEvent) => void,
    logger: StructuredLogger,
    options: TestTerminalManagerOptions = {},
): TerminalManager {
    const managerOptions = omit(options, [
        'execution',
        'outputFlushMs',
        'sampleResources',
        'spawn',
    ]);
    return new TerminalManager(database, emit, logger, {
        ...managerOptions,
        execution: createTestTerminalExecution(
            logger,
            options,
            (terminalId) => database.getTerminal(terminalId)?.provider,
        ),
    });
}
