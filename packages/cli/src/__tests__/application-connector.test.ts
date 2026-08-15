// eslint-disable-next-line unicorn/name-replacements -- this file tests `application.ts`, the CLI composition root's documented name (see AGENTS.md); renaming it would contradict that architecture contract.
import type { ProtocolWelcome } from '@caxri/protocol';
import { CAXRI_PROTOCOL_VERSION, CaxriError } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { CliHostClient } from '../application';
import { createCliHostConnector } from '../application';

function host(): CliHostClient {
    return {
        close: vi.fn(),
        request: vi.fn(() => Promise.resolve({})),
        requestWithId: vi.fn(() => Promise.resolve({})),
        welcome: {
            protocolVersion: CAXRI_PROTOCOL_VERSION,
            principal: { kind: 'human-cli', id: 'cli-test' },
            capabilities: ['host.read'],
            commands: ['host.status'],
        } satisfies ProtocolWelcome,
    };
}

describe('CLI Host connector', () => {
    it.each(['agent', 'ci'] as const)(
        'never starts a Host implicitly for %s automation',
        async (automation) => {
            const connectExisting = vi.fn(() =>
                Promise.reject(new CaxriError('NOT_FOUND', 'No Caxri Host is running')),
            );
            const startHost = vi.fn(() => Promise.resolve(host()));
            const connect = createCliHostConnector({
                automation,
                connectExisting,
                hostLaunch: { executable: '/Applications/Caxri', entryPath: '/app/host.js' },
                startHost,
            });

            await expect(
                connect({ profilePath: '/profiles/selected', timeoutMs: 15_000 }),
            ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
            expect(connectExisting).toHaveBeenCalledOnce();
            expect(startHost).not.toHaveBeenCalled();
        },
    );

    it('never starts a Host implicitly for an Endpoint credential without automation markers', async () => {
        const connectExisting = vi.fn(() =>
            Promise.reject(new CaxriError('NOT_FOUND', 'No Caxri Host is running')),
        );
        const startHost = vi.fn(() => Promise.resolve(host()));
        const connect = createCliHostConnector({
            automation: 'human',
            connectExisting,
            hostLaunch: { executable: '/Applications/Caxri', entryPath: '/app/host.js' },
            startHost,
        });

        await expect(
            connect({
                credential: {
                    kind: 'agent',
                    hostId: 'a'.repeat(32),
                    endpointId: 'endpoint-1',
                    generation: 1,
                    token: 'ab'.repeat(32),
                },
                profilePath: '/profiles/selected',
                timeoutMs: 15_000,
            }),
        ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
        expect(connectExisting).toHaveBeenCalledOnce();
        expect(startHost).not.toHaveBeenCalled();
    });
});
