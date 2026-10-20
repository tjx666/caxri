import { isWindowScopedMethod } from '@caxri/protocol';
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
export async function createTestDomainServices(
    dependencies: TestDomainDependencies,
): Promise<DomainServices> {
    const terminal = dependencies.terminal ?? {};
    const managerOptions = omit(terminal, [
        'execution',
        'outputFlushMs',
        'sampleResources',
        'spawn',
    ]);
    const services = await createDomainServices({
        ...dependencies,
        terminal: managerOptions,
        terminalExecution:
            dependencies.terminalExecution ??
            createTestTerminalExecution(dependencies.logger, terminal),
    });
    /**
     * Stands in for Desktop Main attaching: a real Main reports its window's presence right after bootstrap, and the
     * Server starts with no presence at all. Without this a test Server would treat every Session as hidden.
     */
    const { selectedSessionId } = await services.handlers['app.bootstrap']({ windowKey: 'main' });
    await services.handlers['window.reportPresence']({
        windowKey: 'main',
        viewingSessionId: selectedSessionId ?? null,
        focused: true,
        visible: true,
    });
    /**
     * Desktop Main also tags every window-scoped request with its window's key (see `windowScopedMethods`); a test that
     * calls a handler directly gets the same tag unless it names a window itself.
     */
    const handlers = Object.fromEntries(
        Object.entries(services.handlers).map(([method, handler]) => [
            method,
            isWindowScopedMethod(method)
                ? (parameters: Record<string, unknown> | undefined, ...rest: unknown[]) =>
                      (handler as (...arguments_: unknown[]) => unknown)(
                          { windowKey: 'main', ...parameters },
                          ...rest,
                      )
                : handler,
        ]),
    ) as DomainServices['handlers'];
    return {
        ...services,
        handlers,
        async close() {
            await services.close();
            // The test composition root owns its injected logger and must drain it after every producer stops.
            await dependencies.logger.flush();
        },
    };
}
