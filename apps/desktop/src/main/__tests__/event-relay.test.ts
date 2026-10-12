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

        relay.rendererPending();
        relay.send(replacement);
        expect(delivered).toEqual([]);

        relay.rendererReady();
        expect(delivered).toEqual([replacement]);
        relay.rendererReady();
        expect(delivered).toEqual([replacement]);

        relay.rendererPending();
        relay.rendererReady();
        expect(delivered).toEqual([replacement, replacement]);
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
