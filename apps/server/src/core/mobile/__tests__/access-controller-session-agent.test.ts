import { describe, expect, it } from 'vitest';

import { isMobileGatewayMethodAllowedForRole } from '../role-methods';
import { openSessionController } from './session-requests.fixture';

const agentHistory = {
    entries: [
        {
            provider: 'claude',
            agentSessionId: 'conversation-live',
            boundAt: 3,
            terminalId: 'terminal-granted',
        },
        { provider: 'codex', agentSessionId: 'conversation-closed', title: 'Old plan', boundAt: 2 },
    ],
};

const open = (managedSessionIds: string[] = []) =>
    openSessionController({
        request: (method) => {
            if (method === 'bot.managedSessions')
                return { sessionIds: managedSessionIds, inputTakeBacks: [] };
            if (method === 'session.agentHistory') return agentHistory;
            return;
        },
    });

const agentActions = [
    'mobile.session.restartAgent',
    'mobile.session.detach',
    'mobile.session.resume',
    'mobile.session.handOverToBot',
    'mobile.session.takeBackFromBot',
] as const;

describe('MobileAccessController Session Agent actions', () => {
    it('forwards Restart, Detach, Resume, and Take Back to the Desktop handlers', async () => {
        const { controller, context, domainService, requestWithSignal } = await open();
        try {
            for (const method of [
                'mobile.session.restartAgent',
                'mobile.session.detach',
                'mobile.session.resume',
                'mobile.session.takeBackFromBot',
            ] as const)
                // eslint-disable-next-line no-await-in-loop -- The Desktop handlers are asserted in request order.
                await expect(
                    controller.invokeControl(
                        { method, params: { sessionId: 'session-granted' } },
                        context,
                        domainService,
                    ),
                ).resolves.toEqual({ sessionId: 'session-granted' });
            expect(
                requestWithSignal.mock.calls.map(([method, parameters]) => [method, parameters]),
            ).toEqual([
                ['terminal.restart', { terminalId: 'terminal-granted', mode: 'resume' }],
                ['session.detach', { sessionId: 'session-granted' }],
                ['session.resume', { sessionId: 'session-granted' }],
                ['bot.session.takeBack', { sessionId: 'session-granted' }],
            ]);
        } finally {
            await controller.close();
        }
    });

    it('sets Caxri Bot up before handing the Session over and passes a refusal back as a result', async () => {
        const { controller, context, domainService, requestWithSignal } = await open();
        requestWithSignal.mockImplementation((method) =>
            Promise.resolve(
                method === 'bot.session.handOver'
                    ? { outcomes: [{ outcome: 'rejected', reason: 'task_capacity' }] }
                    : {},
            ),
        );
        try {
            await expect(
                controller.invokeControl(
                    {
                        method: 'mobile.session.handOverToBot',
                        params: { sessionId: 'session-granted' },
                    },
                    context,
                    domainService,
                ),
            ).resolves.toEqual({ outcome: 'rejected', reason: 'task_capacity' });
            expect(
                requestWithSignal.mock.calls.map(([method, parameters]) => [method, parameters]),
            ).toEqual([
                ['bot.ensure', {}],
                ['bot.session.handOver', { sessionIds: ['session-granted'], conversations: [] }],
            ]);
            requestWithSignal.mockImplementation((method) =>
                Promise.resolve(
                    method === 'bot.session.handOver'
                        ? {
                              outcomes: [
                                  {
                                      outcome: 'accepted',
                                      sessionId: 'session-granted',
                                      handoverId: 'handover-1',
                                  },
                              ],
                          }
                        : {},
                ),
            );
            await expect(
                controller.invokeControl(
                    {
                        method: 'mobile.session.handOverToBot',
                        params: { sessionId: 'session-granted' },
                    },
                    context,
                    domainService,
                ),
            ).resolves.toEqual({ outcome: 'accepted', sessionId: 'session-granted' });
        } finally {
            await controller.close();
        }
    });

    it('reopens a conversation and returns the Terminal holding it', async () => {
        const { controller, context, domainService, requestWithSignal } = await open();
        requestWithSignal.mockResolvedValueOnce({ terminalId: 'terminal-reopened' });
        try {
            const parameters = {
                sessionId: 'session-granted',
                provider: 'codex',
                agentSessionId: 'conversation-closed',
            } as const;
            await expect(
                controller.invokeControl(
                    { method: 'mobile.session.reopenConversation', params: parameters },
                    context,
                    domainService,
                ),
            ).resolves.toEqual({ sessionId: 'session-granted', terminalId: 'terminal-reopened' });
            expect(requestWithSignal).toHaveBeenCalledWith(
                'session.reopenConversation',
                parameters,
                expect.any(AbortSignal),
            );
        } finally {
            await controller.close();
        }
    });

    it('reads the menu state: Caxri Bot ownership, a resumable conversation, and only closed conversations', async () => {
        const { controller, context, domainService } = await open(['session-granted']);
        try {
            await expect(
                controller.invokeControl(
                    {
                        method: 'mobile.session.menuState',
                        params: { sessionId: 'session-granted' },
                    },
                    context,
                    domainService,
                ),
            ).resolves.toEqual({
                isBotManaged: true,
                hasConversation: true,
                conversations: [
                    {
                        provider: 'codex',
                        agentSessionId: 'conversation-closed',
                        title: 'Old plan',
                        boundAt: 2,
                    },
                ],
            });
        } finally {
            await controller.close();
        }
    });

    it('refuses a Session outside the grant before calling any Desktop handler', async () => {
        const { controller, context, domainService, request, requestWithSignal } = await open();
        try {
            for (const method of agentActions)
                // eslint-disable-next-line no-await-in-loop -- Each refusal is checked before the next request.
                await expect(
                    controller.invokeControl(
                        { method, params: { sessionId: 'session-hidden' } },
                        context,
                        domainService,
                    ),
                ).rejects.toMatchObject({ code: 'NOT_FOUND' });
            await expect(
                controller.invokeControl(
                    {
                        method: 'mobile.session.reopenConversation',
                        params: {
                            sessionId: 'session-hidden',
                            provider: 'codex',
                            agentSessionId: 'conversation-closed',
                        },
                    },
                    context,
                    domainService,
                ),
            ).rejects.toMatchObject({ code: 'NOT_FOUND' });
            await expect(
                controller.invokeControl(
                    { method: 'mobile.session.menuState', params: { sessionId: 'session-hidden' } },
                    context,
                    domainService,
                ),
            ).rejects.toMatchObject({ code: 'NOT_FOUND' });
            expect(requestWithSignal).not.toHaveBeenCalled();
            expect(
                request.mock.calls.filter(
                    ([method]) =>
                        method === 'bot.managedSessions' || method === 'session.agentHistory',
                ),
            ).toEqual([]);
        } finally {
            await controller.close();
        }
    });

    it('grants the Agent actions and their menu state only to control devices', () => {
        for (const method of [
            ...agentActions,
            'mobile.session.reopenConversation',
            'mobile.session.menuState',
        ])
            expect(
                (['view', 'reply', 'control'] as const).map((role) =>
                    isMobileGatewayMethodAllowedForRole(role, method),
                ),
            ).toEqual([false, false, true]);
    });
});
