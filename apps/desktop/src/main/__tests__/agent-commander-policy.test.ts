import type { CaxriReply } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { AgentCommanderRendererPolicy } from '../agent-commander-policy';

function request(method: string, parameters: Record<string, unknown> = {}) {
    return { protocolVersion: 1, id: 'request-1', method, params: parameters };
}

function ensured(policy: AgentCommanderRendererPolicy, method = 'commander.ensure') {
    policy.observeReply(request(method), {
        ok: true,
        result: {
            identity: { projectId: 'project-1', sessionId: 'session-1', terminalId: 'commander' },
        },
    } as unknown as CaxriReply);
}

describe('Agent Commander Renderer policy', () => {
    it('admits only its read and lifecycle requests', () => {
        const onDenied = vi.fn();
        const policy = new AgentCommanderRendererPolicy(onDenied);

        expect(() => policy.admit(request('commander.board'))).not.toThrow();
        // The board patches its pull request rows from this read after a `sessionPullRequests.changed` event.
        expect(() => policy.admit(request('session.pullRequests'))).not.toThrow();
        expect(() => policy.admit(request('agentCommander.revealSession'))).not.toThrow();
        expect(() => policy.admit(request('agentCommander.openSettings'))).not.toThrow();
        expect(() => policy.admit(request('agentCommander.stop'))).not.toThrow();
        expect(() => policy.admit(request('contextMenu.show', { items: [] }))).not.toThrow();
        for (const method of [
            'commander.inbox.list',
            'commander.inbox.show',
            'commander.inbox.reply',
            'commander.inbox.dismiss',
            'commander.inbox.merge',
        ])
            expect(() => policy.admit(request(method))).not.toThrow();
        for (const method of [
            'agentCommander.openFileLink',
            'app.bootstrap',
            'app.records',
            'commander.inbox.add',
            'commander.inbox.ack',
            'commander.inbox.resolve',
            'commander.stop',
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

    it.each(['commander.ensure', 'commander.snapshot'])(
        'binds Terminal requests to the Terminal named by a %s reply',
        (method) => {
            const policy = new AgentCommanderRendererPolicy(() => {});
            const input = request('terminal.input', { terminalId: 'commander', data: 'x' });
            expect(() => policy.admit(input)).toThrow(
                expect.objectContaining({ code: 'FORBIDDEN' }),
            );

            ensured(policy, method);

            expect(() => policy.admit(input)).not.toThrow();
            expect(() =>
                policy.admit(request('terminal.restart', { terminalId: 'commander' })),
            ).not.toThrow();
            expect(() =>
                policy.admit(
                    request('agentCommander.openFileLink', {
                        terminalId: 'commander',
                        target: 'notes.md',
                    }),
                ),
            ).not.toThrow();
            expect(() =>
                policy.admit(
                    request('agentCommander.openFileLink', {
                        terminalId: 'workbench',
                        target: 'notes.md',
                    }),
                ),
            ).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
            expect(() =>
                policy.admit(request('terminal.input', { terminalId: 'workbench', data: 'x' })),
            ).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
            expect(() =>
                policy.admit(request('terminal.close', { terminalId: 'commander' })),
            ).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
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
        'agentActions.list',
    ])('admits the Chat surface request %s only for the Commander Terminal', (method) => {
        const policy = new AgentCommanderRendererPolicy(() => {});
        ensured(policy);

        expect(() => policy.admit(request(method, { terminalId: 'commander' }))).not.toThrow();
        expect(() => policy.admit(request(method, { terminalId: 'workbench' }))).toThrow(
            expect.objectContaining({ code: 'FORBIDDEN' }),
        );
        expect(() => policy.admit(request(method))).toThrow(
            expect.objectContaining({ code: 'FORBIDDEN' }),
        );
    });

    it('admits Session state writes only for the Commander Session', () => {
        const policy = new AgentCommanderRendererPolicy(() => {});
        const own = request('session.updateState', { sessionId: 'session-1', revision: 0 });
        expect(() => policy.admit(own)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));

        ensured(policy);

        expect(() => policy.admit(own)).not.toThrow();
        expect(() =>
            policy.admit(request('session.updateState', { sessionId: 'workbench', revision: 0 })),
        ).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
    });

    it('ignores a null snapshot and replies to other methods', () => {
        const policy = new AgentCommanderRendererPolicy(() => {});
        policy.observeReply(request('commander.snapshot'), {
            ok: true,
            result: null,
        } as unknown as CaxriReply);
        policy.observeReply(request('settings.get'), {
            ok: true,
            result: { identity: { terminalId: 'commander' } },
        } as unknown as CaxriReply);
        expect(policy.viewedTerminalId()).toBeUndefined();
    });

    it('routes the Commander Terminal output to its window and durable events to both', () => {
        const policy = new AgentCommanderRendererPolicy(() => {});
        ensured(policy);

        expect(
            policy.route({ event: 'terminal.output', payload: { terminalId: 'commander' } }),
        ).toEqual({ commander: true, workbench: false });
        expect(
            policy.route({ event: 'terminal.output', payload: { terminalId: 'workbench' } }),
        ).toEqual({ commander: false, workbench: true });
        expect(
            policy.route({ event: 'agentChat.patch', payload: { terminalId: 'workbench' } }),
        ).toEqual({ commander: false, workbench: true });
        expect(
            policy.route({ event: 'agentChat.taskPatch', payload: { terminalId: 'commander' } }),
        ).toEqual({ commander: true, workbench: false });
        expect(policy.route({ cursor: 3, event: 'session.changed' })).toEqual({
            commander: true,
            workbench: true,
        });
        expect(policy.route({ event: 'command.execute', payload: {} })).toEqual({
            commander: false,
            workbench: true,
        });
    });

    /**
     * Both are transient, so they once reached only the Workbench: after a sleep/wake reconnect the Commander pane
     * never re-attached and froze at the last byte it had, and its board ignored pull request changes until its next
     * poll.
     */
    it.each(['commanderInbox.changed', 'host.connectionChanged', 'sessionPullRequests.changed'])(
        'delivers %s to both windows',
        (event) => {
            const policy = new AgentCommanderRendererPolicy(() => {});
            ensured(policy);

            expect(policy.route({ event, payload: {} })).toEqual({
                commander: true,
                workbench: true,
            });
        },
    );
});
