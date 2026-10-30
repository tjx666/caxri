import type { CommandExecutionContext } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { TerminalExecutionPort } from '../../../domains/terminal';
import { createMemoryMobileDeviceStore } from '../../__tests__/credential-stores.fixture';
import type { ServerDomainService } from '../../domain-service';
import { openMobileAccessController } from '../access-controller';
import { MobileDeviceRegistry } from '../device-registry';

const terminalExecution = {
    onObserverEvent: () => () => {},
    onHostExit: () => () => {},
} as unknown as TerminalExecutionPort;

const open = async () => {
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
    return { controller, context, domainService, requestWithSignal };
};

describe('MobileAccessController Session management', () => {
    it('forwards rename, archive, restore, pin, and delete to the Desktop Session handlers', async () => {
        const { controller, context, domainService, requestWithSignal } = await open();
        try {
            await expect(
                controller.invokeControl(
                    {
                        method: 'mobile.session.rename',
                        params: { sessionId: 'session-granted', title: 'Renamed' },
                    },
                    context,
                    domainService,
                ),
            ).resolves.toEqual({ sessionId: 'session-granted' });
            await controller.invokeControl(
                { method: 'mobile.session.archive', params: { sessionId: 'session-granted' } },
                context,
                domainService,
            );
            await controller.invokeControl(
                { method: 'mobile.session.restore', params: { sessionId: 'session-granted' } },
                context,
                domainService,
            );
            await controller.invokeControl(
                {
                    method: 'mobile.session.setPinned',
                    params: { sessionId: 'session-granted', pinned: true },
                },
                context,
                domainService,
            );
            await controller.invokeControl(
                { method: 'mobile.session.delete', params: { sessionId: 'session-granted' } },
                context,
                domainService,
            );
            expect(
                requestWithSignal.mock.calls.map(([method, parameters]) => [method, parameters]),
            ).toEqual([
                ['session.rename', { sessionId: 'session-granted', title: 'Renamed' }],
                ['session.archive', { sessionId: 'session-granted' }],
                ['session.unarchive', { sessionId: 'session-granted', placement: 'top' }],
                ['session.setPinned', { sessionId: 'session-granted', pinned: true }],
                ['session.delete', { sessionId: 'session-granted' }],
            ]);
        } finally {
            await controller.close();
        }
    });

    it('rejects a Session outside the grant without calling the Desktop handler', async () => {
        const { controller, context, domainService, requestWithSignal } = await open();
        try {
            await expect(
                controller.invokeControl(
                    { method: 'mobile.session.archive', params: { sessionId: 'session-hidden' } },
                    context,
                    domainService,
                ),
            ).rejects.toMatchObject({ code: 'NOT_FOUND' });
            expect(requestWithSignal).not.toHaveBeenCalled();
        } finally {
            await controller.close();
        }
    });

    it('suggests a title only for a granted Session', async () => {
        const { controller, context, domainService } = await open();
        try {
            await expect(
                controller.invokeControl(
                    {
                        method: 'mobile.session.suggestTitle',
                        params: { sessionId: 'session-granted' },
                    },
                    context,
                    domainService,
                ),
            ).resolves.toEqual({ title: 'Suggested' });
            await expect(
                controller.invokeControl(
                    {
                        method: 'mobile.session.suggestTitle',
                        params: { sessionId: 'session-hidden' },
                    },
                    context,
                    domainService,
                ),
            ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        } finally {
            await controller.close();
        }
    });

    it('lists archived Sessions only from granted Projects', async () => {
        const { controller, context, domainService } = await open();
        try {
            await expect(
                controller.invokeControl(
                    { method: 'mobile.session.archived', params: {} },
                    context,
                    domainService,
                ),
            ).resolves.toEqual({
                sessions: [
                    {
                        id: 'session-granted',
                        projectId: 'project-1',
                        title: 'Granted',
                        projectTitle: 'Granted Project',
                        archivedAt: 5,
                    },
                ],
                total: 1,
                truncated: false,
            });
        } finally {
            await controller.close();
        }
    });
});

describe('MobileAccessController Agent surface switch', () => {
    it('forwards a granted Terminal to the Desktop switch and drops the Terminal record', async () => {
        const { controller, context, domainService, requestWithSignal } = await open();
        try {
            await expect(
                controller.invokeControl(
                    {
                        method: 'mobile.terminal.switchSurface',
                        params: {
                            terminalId: 'terminal-granted',
                            surface: 'chat',
                            interruptTurn: true,
                        },
                    },
                    context,
                    domainService,
                ),
            ).resolves.toEqual({ status: 'switched' });
            expect(
                requestWithSignal.mock.calls.map(([method, parameters]) => [method, parameters]),
            ).toEqual([
                [
                    'terminal.switchSurface',
                    { terminalId: 'terminal-granted', surface: 'chat', interruptTurn: true },
                ],
            ]);
        } finally {
            await controller.close();
        }
    });

    it('passes a running turn back without switching', async () => {
        const { controller, context, domainService, requestWithSignal } = await open();
        requestWithSignal.mockResolvedValueOnce({ status: 'turnRunning' });
        try {
            await expect(
                controller.invokeControl(
                    {
                        method: 'mobile.terminal.switchSurface',
                        params: {
                            terminalId: 'terminal-granted',
                            surface: 'pty',
                            interruptTurn: false,
                        },
                    },
                    context,
                    domainService,
                ),
            ).resolves.toEqual({ status: 'turnRunning' });
        } finally {
            await controller.close();
        }
    });

    it('rejects a Terminal outside the grant without relaunching anything', async () => {
        const { controller, context, domainService, requestWithSignal } = await open();
        try {
            await expect(
                controller.invokeControl(
                    {
                        method: 'mobile.terminal.switchSurface',
                        params: {
                            terminalId: 'terminal-hidden',
                            surface: 'chat',
                            interruptTurn: false,
                        },
                    },
                    context,
                    domainService,
                ),
            ).rejects.toMatchObject({ code: 'NOT_FOUND' });
            expect(requestWithSignal).not.toHaveBeenCalled();
        } finally {
            await controller.close();
        }
    });
});
