import type { CaxriReply } from '@caxri/protocol';
import { methods } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { caxriBotMethodClass, CaxriBotRendererPolicy } from '../caxri-bot-policy';

function request(method: string, parameters: Record<string, unknown> = {}) {
    return { protocolVersion: 1, id: 'request-1', method, params: parameters };
}

function ensured(policy: CaxriBotRendererPolicy, method = 'bot.ensure') {
    policy.observeReply(request(method), {
        ok: true,
        result: {
            identity: { projectId: 'project-1', sessionId: 'session-1', terminalId: 'bot' },
        },
    } as unknown as CaxriReply);
}

describe('Caxri Bot Renderer policy', () => {
    it('admits only its read and lifecycle requests', () => {
        const onDenied = vi.fn();
        const policy = new CaxriBotRendererPolicy(onDenied);

        expect(() => policy.admit(request('bot.board'))).not.toThrow();
        // The board patches its pull request rows from this read after a `sessionPullRequests.changed` event.
        expect(() => policy.admit(request('session.pullRequests'))).not.toThrow();
        expect(() => policy.admit(request('caxriBot.revealSession'))).not.toThrow();
        expect(() => policy.admit(request('caxriBot.openSettings'))).not.toThrow();
        expect(() => policy.admit(request('caxriBot.stop'))).not.toThrow();
        expect(() => policy.admit(request('contextMenu.show', { items: [] }))).not.toThrow();
        for (const method of [
            'bot.inbox.list',
            'bot.inbox.show',
            'bot.inbox.reply',
            'bot.inbox.dismiss',
            'bot.inbox.merge',
            // The user's own hand-over picker; Caxri Bot's Agent Endpoint cannot send these.
            'bot.conversations',
            'bot.session.handOver',
            'bot.session.takeBack',
        ])
            expect(() => policy.admit(request(method))).not.toThrow();
        for (const method of [
            'caxriBot.openFileLink',
            'app.bootstrap',
            'app.records',
            'bot.inbox.add',
            'bot.inbox.ack',
            'bot.inbox.resolve',
            'bot.managedSessions',
            'bot.session.archive',
            'bot.stop',
            'file.write',
            'project.add',
            'settings.patch',
            'terminal.openFileLink',
        ]) {
            expect(() => policy.admit(request(method))).toThrow(
                expect.objectContaining({ code: 'FORBIDDEN' }),
            );
        }
        expect(onDenied).toHaveBeenCalledWith('file.write');
    });

    it.each(['bot.ensure', 'bot.snapshot'])(
        'binds Terminal requests to the Terminal named by a %s reply',
        (method) => {
            const policy = new CaxriBotRendererPolicy(() => {});
            const input = request('terminal.input', { terminalId: 'bot', data: 'x' });
            expect(() => policy.admit(input)).toThrow(
                expect.objectContaining({ code: 'FORBIDDEN' }),
            );

            ensured(policy, method);

            expect(() => policy.admit(input)).not.toThrow();
            expect(() =>
                policy.admit(request('terminal.restart', { terminalId: 'bot' })),
            ).not.toThrow();
            expect(() =>
                policy.admit(
                    request('caxriBot.openFileLink', {
                        terminalId: 'bot',
                        target: 'notes.md',
                    }),
                ),
            ).not.toThrow();
            expect(() =>
                policy.admit(
                    request('caxriBot.openFileLink', {
                        terminalId: 'workbench',
                        target: 'notes.md',
                    }),
                ),
            ).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
            expect(() =>
                policy.admit(request('terminal.input', { terminalId: 'workbench', data: 'x' })),
            ).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
            expect(() => policy.admit(request('terminal.close', { terminalId: 'bot' }))).toThrow(
                expect.objectContaining({ code: 'FORBIDDEN' }),
            );
            policy.reset();
            expect(() => policy.admit(input)).toThrow(
                expect.objectContaining({ code: 'FORBIDDEN' }),
            );
        },
    );

    it.each([
        'terminal.switchSurface',
        'agentChat.read',
        'agentChat.send',
        'agentChat.respond',
        'agentChat.rewind',
        'agentChat.restoreFiles',
        'agentActions.list',
        'terminal.agentUsage',
    ])('admits the Chat surface request %s only for Caxri Bot Terminal', (method) => {
        const policy = new CaxriBotRendererPolicy(() => {});
        ensured(policy);

        expect(() => policy.admit(request(method, { terminalId: 'bot' }))).not.toThrow();
        expect(() => policy.admit(request(method, { terminalId: 'workbench' }))).toThrow(
            expect.objectContaining({ code: 'FORBIDDEN' }),
        );
        expect(() => policy.admit(request(method))).toThrow(
            expect.objectContaining({ code: 'FORBIDDEN' }),
        );
    });

    /**
     * The Chat pane offers "Edit from here" and "Restore code to here" in this window; both once failed as `FORBIDDEN`
     * because the policy listed only the Chat requests that existed when it was written.
     */
    it('admits the revert confirmation the Chat pane asks before an edit or restore reverts files', () => {
        const policy = new CaxriBotRendererPolicy(() => {});

        expect(() =>
            policy.admit(
                request('agentChat.confirmRevertFiles', {
                    providerName: 'Claude',
                    removedTurns: 1,
                }),
            ),
        ).not.toThrow();
    });

    it('refuses a fork even for Caxri Bot Terminal', () => {
        const onDenied = vi.fn();
        const policy = new CaxriBotRendererPolicy(onDenied);
        ensured(policy);

        expect(() =>
            policy.admit(request('agentChat.fork', { terminalId: 'bot', itemId: 'item-1' })),
        ).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
        expect(onDenied).toHaveBeenCalledWith('agentChat.fork');
    });

    it('classifies every agentChat.* method in the protocol registry', () => {
        const agentChatMethods = Object.keys(methods).filter((method) =>
            method.startsWith('agentChat.'),
        );
        expect(agentChatMethods.length).toBeGreaterThan(0);
        const unclassified = agentChatMethods.filter(
            (method) => caxriBotMethodClass(method) === undefined,
        );
        expect(unclassified).toEqual([]);
    });

    it('admits Session state writes only for Caxri Bot Session', () => {
        const policy = new CaxriBotRendererPolicy(() => {});
        const own = request('session.updateState', { sessionId: 'session-1', revision: 0 });
        expect(() => policy.admit(own)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));

        ensured(policy);

        expect(() => policy.admit(own)).not.toThrow();
        expect(() =>
            policy.admit(request('session.updateState', { sessionId: 'workbench', revision: 0 })),
        ).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
    });

    it('keeps admitting the reloading document while routing waits for the new one', () => {
        const policy = new CaxriBotRendererPolicy(() => {});
        ensured(policy);
        policy.releaseView();

        // The old document's last resize and layout write can still arrive after the navigation starts.
        expect(() =>
            policy.admit(request('terminal.resize', { terminalId: 'bot', cols: 80, rows: 24 })),
        ).not.toThrow();
        expect(() =>
            policy.admit(request('session.updateState', { sessionId: 'session-1', revision: 0 })),
        ).not.toThrow();
        expect(policy.viewedTerminalId()).toBeUndefined();
        expect(policy.route({ event: 'terminal.output', payload: { terminalId: 'bot' } })).toEqual({
            bot: false,
            workbench: true,
        });

        ensured(policy, 'bot.snapshot');
        expect(policy.viewedTerminalId()).toBe('bot');
    });

    it('ignores a null snapshot and replies to other methods', () => {
        const policy = new CaxriBotRendererPolicy(() => {});
        policy.observeReply(request('bot.snapshot'), {
            ok: true,
            result: null,
        } as unknown as CaxriReply);
        policy.observeReply(request('settings.get'), {
            ok: true,
            result: { identity: { terminalId: 'bot' } },
        } as unknown as CaxriReply);
        expect(policy.viewedTerminalId()).toBeUndefined();
    });

    it('routes Caxri Bot Terminal output to its window and durable events to both', () => {
        const policy = new CaxriBotRendererPolicy(() => {});
        ensured(policy);

        expect(policy.route({ event: 'terminal.output', payload: { terminalId: 'bot' } })).toEqual({
            bot: true,
            workbench: false,
        });
        expect(
            policy.route({ event: 'terminal.output', payload: { terminalId: 'workbench' } }),
        ).toEqual({ bot: false, workbench: true });
        expect(
            policy.route({ event: 'agentChat.patch', payload: { terminalId: 'workbench' } }),
        ).toEqual({ bot: false, workbench: true });
        expect(
            policy.route({ event: 'agentChat.taskPatch', payload: { terminalId: 'bot' } }),
        ).toEqual({ bot: true, workbench: false });
        expect(policy.route({ cursor: 3, event: 'session.changed' })).toEqual({
            bot: true,
            workbench: true,
        });
        expect(policy.route({ event: 'command.execute', payload: {} })).toEqual({
            bot: false,
            workbench: true,
        });
    });

    /**
     * Both are transient, so they once reached only the Workbench: after a sleep/wake reconnect Caxri Bot pane never
     * re-attached and froze at the last byte it had, and its board ignored pull request changes until its next poll.
     */
    it.each(['botInbox.changed', 'host.connectionChanged', 'sessionPullRequests.changed'])(
        'delivers %s to both windows',
        (event) => {
            const policy = new CaxriBotRendererPolicy(() => {});
            ensured(policy);

            expect(policy.route({ event, payload: {} })).toEqual({
                bot: true,
                workbench: true,
            });
        },
    );
});
