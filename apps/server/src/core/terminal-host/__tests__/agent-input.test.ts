import { describe, expect, it, vi } from 'vitest';

import { sendAgentInput, submitAgentInput } from '../agent-input';
import type { RemoteTerminalIdentity, TerminalHostControl } from '../execution-contract';
import { terminal } from './execution-fixtures';

describe('sendAgentInput', () => {
    it('does not send to Terminal Host when authorization is canceled while identity.ready waits', async () => {
        const ready = Promise.withResolvers<void>();
        const cancellation = new AbortController();
        const identity: RemoteTerminalIdentity = {
            agent: { launchId: 'launch-1', processId: 42 },
            generation: 1,
            processId: 43,
            ready: ready.promise,
            record: terminal,
        };
        const request = vi.fn(() => Promise.resolve({ accepted: true }));
        const supervisor = { request } as unknown as TerminalHostControl;
        const inFlight = sendAgentInput(
            supervisor,
            new Map([[terminal.id, identity]]),
            terminal.id,
            'Continue\r',
            cancellation.signal,
        );

        cancellation.abort();
        ready.resolve();
        await expect(inFlight).rejects.toMatchObject({ code: 'CANCELLED' });
        expect(request).not.toHaveBeenCalled();
    });
});

describe('submitAgentInput', () => {
    function liveIdentity(): RemoteTerminalIdentity {
        return {
            agent: { launchId: 'launch-1', processId: 42 },
            generation: 1,
            processId: 43,
            ready: Promise.resolve(),
            record: terminal,
        };
    }

    it('rejects a stale launch before writing and preserves an uncertain Host result', async () => {
        const identity = liveIdentity();
        const request = vi.fn(() => Promise.resolve({ outcome: 'accepted' as const }));
        const supervisor = { request } as unknown as TerminalHostControl;
        const identities = new Map([[terminal.id, identity]]);
        await expect(
            submitAgentInput(
                supervisor,
                identities,
                terminal.id,
                terminal.sessionId,
                'stale-launch',
                '继续\n第二行',
            ),
        ).resolves.toBe('rejected');
        expect(request).not.toHaveBeenCalled();

        request.mockImplementationOnce(() => Promise.reject(new Error('Host disconnected')));
        await expect(
            submitAgentInput(
                supervisor,
                identities,
                terminal.id,
                terminal.sessionId,
                'launch-1',
                '继续\n第二行',
            ),
        ).resolves.toBe('unknown');
        expect(request).toHaveBeenCalledWith(
            {
                method: 'terminal.agent.submit',
                params: { launchId: 'launch-1', text: '继续\n第二行' },
            },
            expect.objectContaining({ ptyGeneration: 1, capability: 'terminal.agent.input' }),
            undefined,
        );
    });

    it('classifies an exact Host launch rejection without retrying', async () => {
        const identity = liveIdentity();
        const request = vi.fn(() =>
            Promise.reject(Object.assign(new Error('denied'), { code: 'CAPABILITY_DENIED' })),
        );
        const supervisor = { request } as unknown as TerminalHostControl;
        await expect(
            submitAgentInput(
                supervisor,
                new Map([[terminal.id, identity]]),
                terminal.id,
                terminal.sessionId,
                'launch-1',
                'message',
            ),
        ).resolves.toBe('rejected');
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('rejects when the Terminal moves to another Session while Host startup is pending', async () => {
        const ready = Promise.withResolvers<void>();
        const identity = liveIdentity();
        identity.ready = ready.promise;
        const request = vi.fn(() => Promise.resolve({ outcome: 'accepted' as const }));
        const supervisor = { request } as unknown as TerminalHostControl;
        const pending = submitAgentInput(
            supervisor,
            new Map([[terminal.id, identity]]),
            terminal.id,
            terminal.sessionId,
            'launch-1',
            'message',
        );
        identity.record = { ...identity.record, sessionId: 'moved-session' };
        ready.resolve();
        await expect(pending).resolves.toBe('rejected');
        expect(request).not.toHaveBeenCalled();
    });
});
