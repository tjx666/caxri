import { describe, expect, it } from 'vitest';

import {
    openSessionController as open,
    sessionReference as reference,
} from './session-requests.fixture';

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

    it("prepares a granted Session's conversation reference and refuses one outside the grant", async () => {
        const { controller, context, domainService, request } = await open();
        try {
            await expect(
                controller.invokeControl(
                    {
                        method: 'mobile.session.conversationReference',
                        params: { sessionId: 'session-granted' },
                    },
                    context,
                    domainService,
                ),
            ).resolves.toEqual(reference);
            await expect(
                controller.invokeControl(
                    {
                        method: 'mobile.session.conversationReference',
                        params: { sessionId: 'session-hidden' },
                    },
                    context,
                    domainService,
                ),
            ).rejects.toMatchObject({ code: 'NOT_FOUND' });
            expect(
                request.mock.calls.filter(([method]) => method === 'session.conversationReference'),
            ).toEqual([['session.conversationReference', { sessionId: 'session-granted' }]]);
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
