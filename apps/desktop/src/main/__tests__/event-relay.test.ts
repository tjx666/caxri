import { describe, expect, it, vi } from 'vitest';

import { createMainEventRelay } from '../event-relay';

describe('Main event relay', () => {
    it('retains a Desktop lease replacement until each Renderer generation is ready', () => {
        const delivered: unknown[] = [];
        const relay = createMainEventRelay({
            deliver: (message) => {
                delivered.push(message);
            },
            loadState: () =>
                Promise.resolve({ projects: [], sessions: [], terminals: [] } as never),
            logger: () => {},
            onMenuRefreshRequested: vi.fn(),
        });
        const replacement = {
            event: 'host.connectionChanged',
            payload: { status: 'replaced' },
        } as const;

        relay.rendererPending('main');
        relay.send(replacement);
        expect(delivered).toEqual([]);

        relay.rendererReady('main');
        expect(delivered).toEqual([replacement]);
        relay.rendererReady('main');
        expect(delivered).toEqual([replacement]);

        relay.rendererPending('main');
        relay.rendererReady('main');
        expect(delivered).toEqual([replacement, replacement]);
    });

    it('replays a retained Desktop lease replacement to each window as it becomes ready', () => {
        const delivered: Array<[unknown, string | undefined]> = [];
        const relay = createMainEventRelay({
            deliver: (message, _event, windowKey) => {
                delivered.push([message, windowKey]);
            },
            loadState: () =>
                Promise.resolve({ projects: [], sessions: [], terminals: [] } as never),
            logger: () => {},
            onMenuRefreshRequested: vi.fn(),
        });
        const replacement = {
            event: 'host.connectionChanged',
            payload: { status: 'replaced' },
        } as const;

        relay.rendererPending('main');
        relay.rendererPending('win-1');
        relay.send(replacement);
        expect(delivered).toEqual([]);

        relay.rendererReady('main');
        relay.rendererReady('win-1');
        expect(delivered).toEqual([
            [replacement, 'main'],
            [replacement, 'win-1'],
        ]);

        relay.windowClosed('win-1');
        relay.send(replacement);
        expect(delivered).toHaveLength(3);
        expect(delivered[2]).toEqual([replacement, undefined]);
    });

    it('addresses an event to one window when the sender names it', () => {
        const delivered: Array<string | undefined> = [];
        const relay = createMainEventRelay({
            deliver: (_message, _event, windowKey) => {
                delivered.push(windowKey);
            },
            loadState: () =>
                Promise.resolve({ projects: [], sessions: [], terminals: [] } as never),
            logger: () => {},
            onMenuRefreshRequested: vi.fn(),
        });
        relay.send(
            { event: 'editor.unsavedRequest', payload: { requestId: 'r', action: 'inspect' } },
            'win-1',
        );
        relay.send({ event: 'command.execute', payload: { command: 'settings.open' } });
        expect(delivered).toEqual(['win-1', undefined]);
    });

    it('publishes durable cursors without replaying PTY output or one-shot commands', async () => {
        const delivered: unknown[] = [];
        const relay = createMainEventRelay({
            deliver: (message) => {
                delivered.push(message);
            },
            loadState: () =>
                Promise.resolve({
                    projects: [{ id: 'project-1' }],
                    sessions: [{ id: 'session-1' }],
                    terminals: [{ id: 'terminal-1' }],
                } as never),
            logger: () => {},
            onMenuRefreshRequested: vi.fn(),
        });

        relay.send({
            event: 'state.changed',
            payload: { kind: 'full', reason: 'project.create' },
        });
        relay.send({
            event: 'terminal.output',
            payload: { terminalId: 'terminal-1', data: 'private output' },
        });
        relay.send({
            event: 'command.execute',
            payload: { command: 'session.delete', viaAccelerator: true },
        });

        expect(delivered[0]).toMatchObject({ protocolVersion: 2, cursor: 1 });
        expect(delivered[1]).toEqual({
            event: 'terminal.output',
            payload: { terminalId: 'terminal-1', data: 'private output' },
        });
        expect(delivered[2]).toEqual({
            event: 'command.execute',
            payload: { command: 'session.delete', viaAccelerator: true },
        });
        await expect(relay.recover(0)).resolves.toMatchObject({
            kind: 'events',
            cursor: 1,
            events: [{ cursor: 1 }],
        });
        expect(JSON.stringify(await relay.recover(0))).not.toContain('session.delete');
    });

    it('requests menu convergence after configuration changes and connection recovery', () => {
        const onMenuRefreshRequested = vi.fn();
        const relay = createMainEventRelay({
            deliver: vi.fn(),
            loadState: () =>
                Promise.resolve({ projects: [], sessions: [], terminals: [] } as never),
            logger: () => {},
            onMenuRefreshRequested,
        });

        relay.send({ event: 'keybindings.changed', payload: { source: '[]' } });
        relay.send({
            event: 'state.changed',
            payload: { kind: 'full', reason: 'unknown' },
        });
        relay.send({
            event: 'host.connectionChanged',
            payload: { attempt: 1, downtimeMs: 10, isHostReplaced: false, status: 'reconnected' },
        });
        relay.send({ event: 'runtime.status', payload: { restartCount: 1, status: 'ready' } });
        relay.send({ event: 'settings.changed', payload: { source: '{}' } });
        relay.send({ event: 'keybindings.changed', payload: { error: 'invalid', source: '[]' } });
        relay.send({
            event: 'host.connectionChanged',
            payload: { status: 'replaced' },
        });
        relay.send({
            event: 'runtime.status',
            payload: { restartCount: 2, status: 'restarting' },
        });

        expect(onMenuRefreshRequested).toHaveBeenCalledTimes(5);
    });
});
