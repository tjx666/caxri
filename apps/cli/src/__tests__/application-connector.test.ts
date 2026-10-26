// eslint-disable-next-line unicorn/name-replacements -- this file tests `application.ts`, the CLI composition root's documented name (see project-architecture); renaming it would contradict that architecture contract.
import type { ProtocolWelcome } from '@caxri/protocol';
import { CAXRI_PROTOCOL_VERSION, CaxriError } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { CliServerClient } from '../application';
import { createCliServerConnector } from '../application';

function server(): CliServerClient {
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

describe('CLI Server connector', () => {
    it.each(['agent', 'ci'] as const)(
        'never starts a Server implicitly for %s automation',
        async (automation) => {
            const connectExisting = vi.fn(() =>
                Promise.reject(new CaxriError('NOT_FOUND', 'No Caxri Server is running')),
            );
            const startServer = vi.fn(() => Promise.resolve(server()));
            const connect = createCliServerConnector({
                automation,
                connectExisting,
                serverLaunch: { artifactRoot: '/Applications/Caxri/server' },
                startServer,
            });

            await expect(
                connect({ profilePath: '/profiles/selected', timeoutMs: 15_000 }),
            ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
            expect(connectExisting).toHaveBeenCalledOnce();
            expect(startServer).not.toHaveBeenCalled();
        },
    );

    it.each([
        {
            kind: 'agent',
            hostId: 'a'.repeat(32),
            endpointId: 'endpoint-1',
            generation: 1,
            token: 'ab'.repeat(32),
        },
        {
            kind: 'delegation-client',
            clientId: 'd1decb80-7644-44fd-b821-a7d6678fb0eb',
            generation: 1,
            token: 'ab'.repeat(32),
        },
    ] as const)(
        'never starts a Server implicitly for a $kind credential without automation markers',
        async (credential) => {
            const connectExisting = vi.fn(() =>
                Promise.reject(new CaxriError('NOT_FOUND', 'No Caxri Server is running')),
            );
            const startServer = vi.fn(() => Promise.resolve(server()));
            const connect = createCliServerConnector({
                automation: 'human',
                connectExisting,
                serverLaunch: { artifactRoot: '/Applications/Caxri/server' },
                startServer,
            });

            await expect(
                connect({
                    credential,
                    profilePath: '/profiles/selected',
                    timeoutMs: 15_000,
                }),
            ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
            expect(connectExisting).toHaveBeenCalledOnce();
            expect(startServer).not.toHaveBeenCalled();
        },
    );
});
