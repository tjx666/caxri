import { DEFAULT_AGENT_SESSION_INSTRUCTIONS } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { AgentChatEndpoint } from '../service-options';
import { fixture } from './chat-service-fixture';

function endpoint(overrides: Partial<AgentChatEndpoint> = {}) {
    return {
        activate: vi.fn<AgentChatEndpoint['activate']>(() => Promise.resolve()),
        environment: vi.fn<AgentChatEndpoint['environment']>(() =>
            Promise.resolve({ CAXRI_TEST_ENDPOINT: 'generation-1' }),
        ),
        retire: vi.fn<AgentChatEndpoint['retire']>(() => Promise.resolve()),
        ...overrides,
    };
}

describe('Agent Chat Endpoint', () => {
    it('spawns with the Endpoint environment, activates it once ready, and retires it when the process stops', async () => {
        const lease = endpoint();
        const { service, spawnProcess, terminal, until } = await fixture({ endpoint: lease });
        service.read(terminal.id);
        await until((snapshot) => snapshot.status === 'ready');

        expect(lease.environment).toHaveBeenCalledWith(
            expect.objectContaining({ id: terminal.id }),
            expect.any(String),
        );
        expect(spawnProcess.mock.calls[0]?.[2].env).toMatchObject({
            CAXRI_TEST_ENDPOINT: 'generation-1',
        });
        expect(lease.activate).toHaveBeenCalledExactlyOnceWith(terminal.id);
        expect(lease.retire).not.toHaveBeenCalled();

        await service.close(terminal.id);
        await vi.waitFor(() => expect(lease.retire).toHaveBeenCalledWith(terminal.id));
    });

    it('tells an Agent that carries the Caxri CLI how to start work in another Session', async () => {
        const lease = endpoint({
            environment: vi.fn(() => Promise.resolve({ CAXRI_CLI: '/profile/bin/caxri' })),
        });
        const { service, terminal, threadOpens, until } = await fixture({ endpoint: lease });
        service.read(terminal.id);
        await until((snapshot) => snapshot.status === 'ready');

        expect((await threadOpens()).at(-1)).toMatchObject({
            developerInstructions: DEFAULT_AGENT_SESSION_INSTRUCTIONS,
        });
    });

    it('sends the instructions the user wrote in Settings instead of the preset', async () => {
        const lease = endpoint({
            environment: vi.fn(() => Promise.resolve({ CAXRI_CLI: '/profile/bin/caxri' })),
        });
        const { service, terminal, threadOpens, until } = await fixture({
            endpoint: lease,
            sessionInstructions: () => '  Reply in haiku.\n',
        });
        service.read(terminal.id);
        await until((snapshot) => snapshot.status === 'ready');

        expect((await threadOpens()).at(-1)).toMatchObject({
            developerInstructions: 'Reply in haiku.',
        });
    });

    it('adds no instructions when the user cleared them in Settings', async () => {
        const lease = endpoint({
            environment: vi.fn(() => Promise.resolve({ CAXRI_CLI: '/profile/bin/caxri' })),
        });
        const { service, terminal, threadOpens, until } = await fixture({
            endpoint: lease,
            sessionInstructions: () => ' \n ',
        });
        service.read(terminal.id);
        await until((snapshot) => snapshot.status === 'ready');

        expect((await threadOpens()).at(-1)).not.toHaveProperty('developerInstructions');
    });

    it('adds no instructions to an Agent without the Caxri CLI', async () => {
        const { service, terminal, threadOpens, until } = await fixture({ endpoint: endpoint() });
        service.read(terminal.id);
        await until((snapshot) => snapshot.status === 'ready');

        expect((await threadOpens()).at(-1)).not.toHaveProperty('developerInstructions');
    });

    it('fails the start and retires the generation when activation is refused', async () => {
        const lease = endpoint({
            activate: vi.fn(() => Promise.reject(new Error('generation changed'))),
        });
        const { service, terminal, until } = await fixture({ endpoint: lease });
        service.read(terminal.id);
        await until((snapshot) => snapshot.status === 'failed');

        await vi.waitFor(() => expect(lease.retire).toHaveBeenCalledWith(terminal.id));
    });

    it('keeps the Chat running when retiring the generation fails', async () => {
        const lease = endpoint({ retire: vi.fn(() => Promise.reject(new Error('retire failed'))) });
        const { service, terminal, until } = await fixture({ endpoint: lease });
        service.read(terminal.id);
        await until((snapshot) => snapshot.status === 'ready');

        await expect(service.restart(terminal.id)).resolves.toMatchObject({ id: terminal.id });
        await until((snapshot) => snapshot.status === 'ready');
        expect(lease.activate).toHaveBeenCalledTimes(2);
    });
});
