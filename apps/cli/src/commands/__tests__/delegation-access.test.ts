import type { ProtocolWelcome } from '@caxri/protocol';
import { CAXRI_PROTOCOL_VERSION } from '@caxri/protocol';
import { expect, it, vi } from 'vitest';

import type { CliConnectOptions, CliServerClient } from '../../application';
import { runCli } from '../../application';

it('requires explicit owner authorization and sends a bounded bootstrap request', async () => {
    const request = vi.fn(() => Promise.resolve({}));
    const client: CliServerClient = {
        close: vi.fn(),
        request,
        requestWithId: request,
        welcome: {
            protocolVersion: CAXRI_PROTOCOL_VERSION,
            principal: { kind: 'human-cli', id: 'owner' },
            capabilities: ['agents.delegation.access'],
            commands: ['agent.delegation.access.create'],
        } satisfies ProtocolWelcome,
    };
    const connect = vi.fn(() => Promise.resolve(client));
    const output = {
        writeStdout: vi.fn(),
        writeStderr: vi.fn(),
        stdinIsTTY: false,
        stdoutIsTTY: false,
        stderrIsTTY: false,
    };
    const arguments_ = [
        'agent',
        'delegate',
        'access',
        'create',
        '--root',
        '/explicit/root',
        '--provider',
        'codex',
        '--register-project',
        '--ttl-ms',
        '60000',
        '--profile',
        '/profiles/owner',
        '--yes',
        '--json',
    ];
    expect(
        await runCli(arguments_, {
            connect,
            environment: { CODEX_THREAD_ID: 'external' },
            io: output,
        }),
    ).toBe(5);
    expect(connect).not.toHaveBeenCalled();
    expect(await runCli(arguments_, { connect, environment: {}, io: output })).toBe(0);
    expect(request).toHaveBeenCalledWith('agent.delegation.access.create', {
        rootPath: '/explicit/root',
        callerProvider: 'codex',
        registerProject: true,
        ttlMs: 60_000,
    });
});

it('uses the external identity for context and never falls back to owner credentials when incomplete', async () => {
    const clientId = 'd1decb80-7644-44fd-b821-a7d6678fb0eb';
    const client: CliServerClient = {
        close: vi.fn(),
        request: vi.fn(),
        requestWithId: vi.fn(),
        welcome: {
            protocolVersion: CAXRI_PROTOCOL_VERSION,
            principal: {
                kind: 'delegation-client',
                id: `delegation-client:${clientId}`,
                clientId,
                generation: 1,
                projectIds: ['project'],
                sessionId: 'session',
                callerProvider: 'codex',
            },
            capabilities: ['agents.delegate'],
            commands: ['agent.delegation.create'],
        },
    };
    const connect = vi.fn<(options: CliConnectOptions) => Promise<CliServerClient>>(() =>
        Promise.resolve(client),
    );
    let stdout = '';
    const output = {
        writeStdout: (text: string) => {
            stdout += text;
        },
        writeStderr: vi.fn(),
        stdinIsTTY: false,
        stdoutIsTTY: false,
        stderrIsTTY: false,
    };
    const environment = {
        CAXRI_USER_DATA_DIR: '/profiles/external',
        CAXRI_DELEGATION_CLIENT_ID: clientId,
        CAXRI_DELEGATION_GENERATION: '1',
        CAXRI_DELEGATION_TOKEN: 'ab'.repeat(32),
    };
    expect(await runCli(['agent-context', '--json'], { connect, environment, io: output })).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
        principal: { kind: 'delegation-client', projectIds: ['project'], sessionId: 'session' },
    });
    expect(stdout).not.toContain(environment.CAXRI_DELEGATION_TOKEN);
    expect(client.request).not.toHaveBeenCalled();
    expect(connect.mock.calls[0][0].profilePath).toBe('/profiles/external');
    expect(connect.mock.calls[0][0].credential).toMatchObject({
        kind: 'delegation-client',
        clientId,
    });
    connect.mockClear();
    expect(
        await runCli(['agent-context', '--json'], {
            connect,
            environment: { ...environment, CAXRI_DELEGATION_GENERATION: undefined },
            io: output,
        }),
    ).not.toBe(0);
    expect(connect).not.toHaveBeenCalled();
});
