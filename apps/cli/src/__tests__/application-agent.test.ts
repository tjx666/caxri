// eslint-disable-next-line unicorn/name-replacements -- this file tests `application.ts`, the CLI composition root's documented name (see project-architecture).
import { CAXRI_PROTOCOL_VERSION } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { CliConnectOptions, CliServerClient } from '../application';
import { runCli } from '../application';
import { io, server } from './cli-test-support';

describe('CLI application Agent Endpoint commands', () => {
    it('uses the complete generation credential for remote Agent context without printing it', async () => {
        const output = io();
        const token = 'ab'.repeat(32);
        const context = {
            status: 'active',
            endpoint: {
                ref: { hostId: 'a'.repeat(32), endpointId: 'endpoint-1', generation: 2 },
                projectId: 'project-1',
                sessionId: 'session-1',
                terminalId: 'terminal-1',
                provider: 'codex',
                name: 'Codex',
                permissionClass: 'standard',
                messaging: {
                    deliveryMode: 'unavailable',
                    health: 'unsupported',
                    reason: 'adapter_unavailable',
                    checkedAt: 1,
                    nextAction: 'restart_terminal',
                },
                expiresAt: 10_000,
            },
            capabilities: ['agents.read'],
            grants: [],
        };
        const client = server(context, ['agent.context']);
        client.welcome = {
            protocolVersion: CAXRI_PROTOCOL_VERSION,
            principal: {
                kind: 'agent',
                id: 'agent:endpoint-1',
                endpointId: 'endpoint-1',
                generation: 2,
                projectIds: ['project-1'],
            },
            capabilities: ['agents.read'],
            commands: ['agent.context'],
        };
        const connect = vi.fn<(options: CliConnectOptions) => Promise<CliServerClient>>(() =>
            Promise.resolve(client),
        );

        await expect(
            runCli(['agent-context', '--json'], {
                connect,
                environment: {
                    CODEX_THREAD_ID: 'thread-1',
                    CAXRI_AGENT_ENDPOINT_HOST_ID: 'a'.repeat(32),
                    CAXRI_AGENT_ENDPOINT_ID: 'endpoint-1',
                    CAXRI_AGENT_ENDPOINT_GENERATION: '2',
                    CAXRI_AGENT_ENDPOINT_TOKEN: token,
                    CAXRI_USER_DATA_DIR: '/profiles/agent',
                },
                io: output.io,
            }),
        ).resolves.toBe(0);

        expect(connect.mock.calls[0]?.[0]).toMatchObject({
            profilePath: '/profiles/agent',
            credential: {
                kind: 'agent',
                hostId: 'a'.repeat(32),
                endpointId: 'endpoint-1',
                generation: 2,
                token,
            },
        });
        expect(client.request).toHaveBeenCalledWith('agent.context', {});
        expect(output.stdout()).toContain('"endpointId":"endpoint-1"');
        expect(`${output.stdout()}${output.stderr()}`).not.toContain(token);

        const humanOutput = io();
        await expect(
            runCli(['agent-context'], {
                connect,
                environment: {
                    CAXRI_AGENT_ENDPOINT_HOST_ID: 'a'.repeat(32),
                    CAXRI_AGENT_ENDPOINT_ID: 'endpoint-1',
                    CAXRI_AGENT_ENDPOINT_GENERATION: '2',
                    CAXRI_AGENT_ENDPOINT_TOKEN: token,
                    CAXRI_USER_DATA_DIR: '/profiles/agent',
                },
                io: humanOutput.io,
            }),
        ).resolves.toBe(0);
        expect(humanOutput.stdout()).toContain('Delivery: unavailable');
        expect(humanOutput.stdout()).toContain('Health: unsupported');
        expect(humanOutput.stdout()).toContain('Restart this Agent Terminal');
    });

    it('sends and waits for peer messages only with the inherited Agent Endpoint credential', async () => {
        const endpointEnvironment = {
            CODEX_THREAD_ID: 'thread-1',
            CAXRI_AGENT_ENDPOINT_HOST_ID: 'a'.repeat(32),
            CAXRI_AGENT_ENDPOINT_ID: 'endpoint-1',
            CAXRI_AGENT_ENDPOINT_GENERATION: '2',
            CAXRI_AGENT_ENDPOINT_TOKEN: 'ab'.repeat(32),
            CAXRI_USER_DATA_DIR: '/profiles/agent',
        };
        const peerReference = `${'a'.repeat(32)}:endpoint-2:1`;
        const receipt = {
            messageId: 'message-1',
            from: { hostId: 'a'.repeat(32), endpointId: 'endpoint-1', generation: 2 },
            to: { hostId: 'a'.repeat(32), endpointId: 'endpoint-2', generation: 1 },
            status: 'waiting',
            createdAt: 1,
            updatedAt: 1,
            expiresAt: 2,
        };
        const senderOutput = io();
        const senderClient = server(receipt, ['agent.message.send']);
        senderClient.welcome = {
            protocolVersion: CAXRI_PROTOCOL_VERSION,
            principal: {
                kind: 'agent',
                id: 'agent:endpoint-1',
                endpointId: 'endpoint-1',
                generation: 2,
                projectIds: ['project-1'],
            },
            capabilities: ['agents.message'],
            commands: ['agent.message.send'],
        };

        await expect(
            runCli(
                [
                    'agent',
                    'message',
                    'send',
                    '--to',
                    peerReference,
                    '--body',
                    'private peer body',
                    '--request-id',
                    'message-request-1',
                    '--json',
                ],
                {
                    connect: () => Promise.resolve(senderClient),
                    environment: endpointEnvironment,
                    io: senderOutput.io,
                },
            ),
        ).resolves.toBe(0);
        expect(senderClient.requestWithId).toHaveBeenCalledWith(
            'message-request-1',
            'agent.message.send',
            {
                to: { hostId: 'a'.repeat(32), endpointId: 'endpoint-2', generation: 1 },
                body: 'private peer body',
            },
        );
        expect(senderOutput.stdout()).not.toContain('private peer body');

        const waitOutput = io();
        const waitClient = server(
            {
                message: {
                    id: 'message-1',
                    origin: 'peer',
                    body: 'private peer body',
                },
                outcome: 'message',
            },
            ['agent.message.wait'],
        );
        waitClient.welcome = {
            ...senderClient.welcome,
            commands: ['agent.message.wait'],
        };
        const waitConnect = vi.fn(() => Promise.resolve(waitClient));
        await expect(
            runCli(
                [
                    'agent',
                    'message',
                    'wait',
                    '--connect-timeout',
                    '4321',
                    '--timeout',
                    '1234',
                    '--json',
                ],
                {
                    connect: waitConnect,
                    environment: endpointEnvironment,
                    io: waitOutput.io,
                },
            ),
        ).resolves.toBe(0);
        expect(waitConnect).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 4_321 }));
        expect(waitClient.request).toHaveBeenCalledWith('agent.message.wait', { timeoutMs: 1_234 });
        expect(waitClient.request).not.toHaveBeenCalledWith('agent.message.check', {});
        expect(waitOutput.stdout()).toContain('private peer body');

        const checkOutput = io();
        const checkClient = server({ message: null, outcome: 'empty' }, ['agent.message.check']);
        checkClient.welcome = {
            ...senderClient.welcome,
            commands: ['agent.message.check'],
        };
        await expect(
            runCli(['agent', 'message', 'check', '--json'], {
                connect: () => Promise.resolve(checkClient),
                environment: endpointEnvironment,
                io: checkOutput.io,
            }),
        ).resolves.toBe(0);
        expect(checkClient.request).toHaveBeenCalledWith('agent.message.check', {});
        expect(checkOutput.stdout()).toContain('"outcome":"empty"');
    });

    it('rejects Peer Inbox commands before connecting when no Agent credential is present', async () => {
        const output = io();
        const connect = vi.fn();

        await expect(
            runCli(
                [
                    'agent',
                    'message',
                    'send',
                    '--to',
                    `${'a'.repeat(32)}:endpoint-2:1`,
                    '--body',
                    'body',
                    '--json',
                ],
                { connect, io: output.io },
            ),
        ).resolves.not.toBe(0);
        expect(connect).not.toHaveBeenCalled();
        expect(output.stderr()).toContain('Agent Endpoint credential');
    });
});
