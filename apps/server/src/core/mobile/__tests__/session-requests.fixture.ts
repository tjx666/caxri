import type { CommandExecutionContext } from '@caxri/protocol';
import { vi } from 'vitest';

import type { TerminalExecutionPort } from '../../../domains/terminal';
import { createMemoryMobileDeviceStore } from '../../__tests__/credential-stores.fixture';
import type { ServerDomainService } from '../../domain-service';
import { openMobileAccessController } from '../access-controller';
import { MobileDeviceRegistry } from '../device-registry';

const terminalExecution = {
    onObserverEvent: () => () => {},
    onHostExit: () => () => {},
} as unknown as TerminalExecutionPort;

export const sessionReference = {
    filePath: '/refs/granted.md',
    title: 'Granted',
    messageCount: 2,
    omittedMessageCount: 0,
};

/**
 * A paired control phone granted `project-1`, whose one Session `session-granted` (primary Agent `terminal-granted`)
 * the principal-scoped queries return. `request` answers a Desktop read the default fake does not know; returning
 * `undefined` falls through to the unexpected-method error.
 */
export const openSessionController = async ({
    request: answer,
}: { request?: (method: string, parameters: unknown) => unknown } = {}) => {
    const store = createMemoryMobileDeviceStore();
    const registry = MobileDeviceRegistry.open({ store });
    const paired = await registry.pair({
        displayName: 'Test phone',
        platform: 'ios',
        projectIds: ['project-1'],
    });
    const principal = registry.authenticate({
        credential: paired.credential,
        deviceId: paired.device.deviceId,
        generation: paired.device.generation,
    });
    const controller = openMobileAccessController({ store });
    controller.attach(
        { invoke: vi.fn() },
        'b'.repeat(32),
        { serverId: 'a'.repeat(32), stateEpoch: 'c'.repeat(32) },
        {} as ServerDomainService,
        terminalExecution,
        () => {},
    );
    const sessions = [
        {
            id: 'session-granted',
            projectId: 'project-1',
            title: 'Granted',
            lastVisitedAt: 1,
            agentActivityState: 'completed',
            attentionGeneration: 0,
            hasUnread: false,
            archivedAt: 5,
            primaryAgentTerminalId: 'terminal-granted',
        },
    ];
    const request = vi.fn(
        (method: string, parameters?: { query?: { mode: string; selector?: string } }) => {
            if (method === 'project.queryForPrincipal')
                return Promise.resolve({
                    projects: [
                        { id: 'project-1', title: 'Granted Project' },
                        { id: 'project-2', title: 'Other Project' },
                    ],
                });
            if (method === 'session.queryForPrincipal')
                return Promise.resolve({
                    sessions:
                        parameters?.query?.mode === 'show'
                            ? sessions.filter(({ id }) => id === parameters.query?.selector)
                            : sessions,
                });
            if (method === 'session.suggestTitle') return Promise.resolve({ title: 'Suggested' });
            if (method === 'session.conversationReference')
                return Promise.resolve(sessionReference);
            const answered = answer?.(method, parameters);
            if (answered !== undefined) return Promise.resolve(answered);
            if (method === 'terminal.queryForPrincipal')
                return Promise.resolve({
                    terminals:
                        parameters?.query?.selector === 'terminal-granted'
                            ? [{ id: 'terminal-granted', sessionId: 'session-granted' }]
                            : [],
                });
            throw new Error(`Unexpected method: ${method}`);
        },
    );
    const requestWithSignal = vi.fn<(method: string, parameters: unknown) => Promise<unknown>>(
        (method) =>
            Promise.resolve(
                method === 'terminal.switchSurface'
                    ? { status: 'switched', terminal: { id: 'terminal-granted' } }
                    : {},
            ),
    );
    const domainService = { request, requestWithSignal } as unknown as ServerDomainService;
    const context: CommandExecutionContext = { capabilities: [], principal };
    return { controller, context, domainService, request, requestWithSignal };
};
