import type { ProtocolWelcome } from '@caxri/protocol';
import { CAXRI_PROTOCOL_VERSION } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { CliHostClient, CliIo } from '../../application';
import { runCli } from '../../application';
import { CLI_VERSION } from '../../version';

function io(options: Partial<CliIo> = {}) {
    let stdout = '';
    let stderr = '';
    const value: CliIo = {
        stderrIsTTY: true,
        stdinIsTTY: true,
        stdoutIsTTY: true,
        writeStderr: (text) => {
            stderr += text;
        },
        writeStdout: (text) => {
            stdout += text;
        },
        ...options,
    };
    return { io: value, stderr: () => stderr, stdout: () => stdout };
}

function host(result: unknown, commands: string[]): CliHostClient {
    return {
        close: vi.fn(),
        hostVersion: CLI_VERSION,
        request: vi.fn(() => Promise.resolve(result)),
        requestWithId: vi.fn(() => Promise.resolve(result)),
        welcome: {
            protocolVersion: CAXRI_PROTOCOL_VERSION,
            principal: { kind: 'human-cli', id: 'cli-test' },
            capabilities: ['agents.dispatch', 'terminals.steer'],
            commands,
        } satisfies ProtocolWelcome,
    };
}

describe('CLI Agent commands', () => {
    it('reports one exact worktree path through the authenticated Agent Endpoint', async () => {
        const endpointEnvironment = {
            CAXRI_AGENT_ENDPOINT_HOST_ID: 'a'.repeat(32),
            CAXRI_AGENT_ENDPOINT_ID: 'endpoint-1',
            CAXRI_AGENT_ENDPOINT_GENERATION: '2',
            CAXRI_AGENT_ENDPOINT_TOKEN: 'ab'.repeat(32),
            CAXRI_USER_DATA_DIR: '/profiles/agent',
        };
        const client = host({ status: 'accepted', action: 'candidate' }, [
            'agent.worktree.created',
        ]);
        client.welcome = {
            protocolVersion: CAXRI_PROTOCOL_VERSION,
            principal: {
                kind: 'agent',
                id: 'agent:endpoint-1',
                endpointId: 'endpoint-1',
                generation: 2,
                projectIds: ['project-1'],
            },
            capabilities: ['worktrees.report'],
            commands: ['agent.worktree.created'],
        };

        await expect(
            runCli(['agent', 'worktree', 'created', '/projects/repo-worktree', '--json'], {
                connect: () => Promise.resolve(client),
                environment: endpointEnvironment,
                io: io().io,
            }),
        ).resolves.toBe(0);
        expect(client.request).toHaveBeenCalledWith('agent.worktree.created', {
            rootPath: '/projects/repo-worktree',
        });

        const denied = io();
        const connect = vi.fn();
        await expect(
            runCli(['agent', 'worktree', 'created', '/projects/repo-worktree', '--json'], {
                connect,
                environment: {},
                io: denied.io,
            }),
        ).resolves.toBe(5);
        expect(connect).not.toHaveBeenCalled();
        expect(denied.stderr()).toContain('directly managed Caxri Agent Endpoint credential');

        const stale = io();
        client.hostVersion = '0.0.1';
        await expect(
            runCli(['agent', 'worktree', 'created', '/projects/repo-worktree', '--json'], {
                connect: () => Promise.resolve(client),
                environment: endpointEnvironment,
                io: stale.io,
            }),
        ).resolves.toBe(4);
        expect(stale.stderr()).toContain('CLI version bundled with the active Caxri Host');
    });

    it('keeps dispatch waits Agent-capable while rejecting human steer from Agent credentials', async () => {
        const endpointEnvironment = {
            CAXRI_AGENT_ENDPOINT_HOST_ID: 'a'.repeat(32),
            CAXRI_AGENT_ENDPOINT_ID: 'endpoint-1',
            CAXRI_AGENT_ENDPOINT_GENERATION: '2',
            CAXRI_AGENT_ENDPOINT_TOKEN: 'ab'.repeat(32),
            CAXRI_USER_DATA_DIR: '/profiles/agent',
        };
        const launch = {
            provider: 'codex',
            mode: 'fresh',
            executable: 'codex',
            argumentCount: 0,
            fingerprint: 'a'.repeat(64),
        };
        const receipt = {
            dispatchId: 'dispatch-1',
            operation: 'start',
            status: 'running',
            projectId: 'project-1',
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            provider: 'codex',
            requestedLaunch: launch,
            effectiveLaunch: launch,
            revision: 2,
            createdAt: 1,
            updatedAt: 2,
        };
        const client = host({ receipt, outcome: 'timed_out' }, ['agent.dispatch.wait']);
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
            commands: ['agent.dispatch.wait'],
        };

        await expect(
            runCli(
                [
                    'agent',
                    'dispatch',
                    'wait',
                    'dispatch-1',
                    '--after-revision',
                    '2',
                    '--timeout',
                    '500',
                    '--json',
                ],
                {
                    connect: () => Promise.resolve(client),
                    environment: endpointEnvironment,
                    io: io().io,
                },
            ),
        ).resolves.toBe(0);
        expect(client.request).toHaveBeenCalledWith('agent.dispatch.wait', {
            dispatchId: 'dispatch-1',
            afterRevision: 2,
            timeoutMs: 500,
        });

        const denied = io();
        const connect = vi.fn();
        await expect(
            runCli(
                ['terminal', 'send', '--terminal', 'terminal-1', '--text', 'not human', '--enter'],
                { connect, environment: endpointEnvironment, io: denied.io },
            ),
        ).resolves.toBe(5);
        expect(connect).not.toHaveBeenCalled();
        expect(denied.stderr()).toContain('human profile owner');
    });

    it('sends explicit owner dispatch and human Terminal steer commands without echoing text', async () => {
        const dispatchOutput = io({ stdinIsTTY: false, stdoutIsTTY: false });
        const dispatchClient = host({ dispatchId: 'dispatch-1' }, ['agent.dispatch.start']);
        await expect(
            runCli(
                [
                    'agent',
                    'dispatch',
                    'start',
                    '--project',
                    'project-1',
                    '--session',
                    'session-1',
                    '--provider',
                    'codex',
                    '--profile',
                    '/profiles/selected',
                    '--request-id',
                    'dispatch-1',
                    '--yes',
                    '--json',
                ],
                { connect: () => Promise.resolve(dispatchClient), io: dispatchOutput.io },
            ),
        ).resolves.toBe(0);
        expect(dispatchClient.requestWithId).toHaveBeenCalledWith(
            'dispatch-1',
            'agent.dispatch.start',
            { projectId: 'project-1', sessionId: 'session-1', provider: 'codex' },
        );

        const steerOutput = io({ stdinIsTTY: false, stdoutIsTTY: false });
        const steerClient = host(
            { terminalId: 'terminal-1', accepted: true, byteLength: 14, enter: true },
            ['terminal.send'],
        );
        await expect(
            runCli(
                [
                    'terminal',
                    'send',
                    '--terminal',
                    'terminal-1',
                    '--text',
                    'private prompt',
                    '--enter',
                    '--profile',
                    '/profiles/selected',
                    '--yes',
                    '--json',
                ],
                { connect: () => Promise.resolve(steerClient), io: steerOutput.io },
            ),
        ).resolves.toBe(0);
        expect(steerClient.request).toHaveBeenCalledWith('terminal.send', {
            terminalId: 'terminal-1',
            text: 'private prompt',
            enter: true,
        });
        expect(steerOutput.stdout()).not.toContain('private prompt');
    });
});
