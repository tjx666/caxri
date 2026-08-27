import { omit } from 'es-toolkit';

import { createDomainServices } from '../../domains/create-domain-services';
import type { DomainDependencies, DomainServices } from '../../domains/domain-services';
import type { TestTerminalManagerOptions } from './terminal';
import { createTestTerminalExecution } from './terminal';

export type TestDomainDependencies = Omit<DomainDependencies, 'terminal' | 'terminalExecution'> & {
    terminal?: TestTerminalManagerOptions;
    terminalExecution?: DomainDependencies['terminalExecution'];
};

/**
 * Supplies the in-process Terminal adapter at the test composition root without making it a production fallback.
 */
export function createTestDomainServices(
    dependencies: TestDomainDependencies,
): Promise<DomainServices> {
    const terminal = dependencies.terminal ?? {};
    const managerOptions = omit(terminal, [
        'execution',
        'outputFlushMs',
        'sampleResources',
        'spawn',
    ]);
    return createDomainServices({
        ...dependencies,
        terminal: managerOptions,
        terminalExecution:
            dependencies.terminalExecution ??
            createTestTerminalExecution(dependencies.logger, terminal),
    });
}
