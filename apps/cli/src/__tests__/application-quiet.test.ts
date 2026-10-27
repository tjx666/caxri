// eslint-disable-next-line unicorn/name-replacements -- this file tests `application.ts`, the CLI composition root's documented name (see project-architecture).
import type { AgentEndpointSummary, ProtocolWelcome } from '@caxri/protocol';
import { CAXRI_PROTOCOL_VERSION } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { CliIo, CliServerClient } from '../application';
import { runCli } from '../application';

function io() {
    let stdout = '';
    let stderr = '';
    const value: CliIo = {
        stderrIsTTY: false,
        stdinIsTTY: false,
        stdoutIsTTY: false,
        writeStderr: (text) => {
            stderr += text;
        },
        writeStdout: (text) => {
            stdout += text;
        },
    };
    return { io: value, stderr: () => stderr, stdout: () => stdout };
}

function server(result: unknown, method: string): CliServerClient {
    return {
        close: vi.fn(),
        request: vi.fn(() => Promise.resolve(result)),
        requestWithId: vi.fn(() => Promise.resolve(result)),
        welcome: {
            protocolVersion: CAXRI_PROTOCOL_VERSION,
            principal: { kind: 'human-cli', id: 'cli-test' },
            capabilities: ['bot'],
            commands: [method],
        } satisfies ProtocolWelcome,
    };
}

function agentEndpoint(endpointId: string, generation: number): AgentEndpointSummary {
    return {
        ref: { hostId: 'host-1', endpointId, generation },
        projectId: 'project-1',
        sessionId: 'session-1',
        terminalId: `terminal-${endpointId}`,
        provider: 'codex',
        name: 'Codex',
        permissionClass: 'standard',
        messaging: {
            deliveryMode: 'pull',
            health: 'ready',
            reason: 'pull_ready',
            checkedAt: 1,
            nextAction: 'use_pull',
        },
        expiresAt: 1,
    };
}

/**
 * `--quiet` prints after the request already ran, so a projection that cannot find the ID turns a Session that was
 * created into a `VALIDATION` exit, and a retry creates a second one.
 */
describe('quiet output', () => {
    it('prints the created Session ID and exits 0', async () => {
        const output = io();
        const client = server(
            { projectId: 'project-1', sessionId: 'session-1' },
            'bot.session.create',
        );

        await expect(
            runCli(
                [
                    'bot',
                    'session',
                    'create',
                    '--project',
                    'project-1',
                    '--profile',
                    '/profiles/selected',
                    '--yes',
                    '--quiet',
                ],
                { connect: () => Promise.resolve(client), io: output.io },
            ),
        ).resolves.toBe(0);
        expect(output.stderr()).toBe('');
        expect(output.stdout()).toBe('session-1\n');
    });

    it('prints the Terminal ID a send reached', async () => {
        const output = io();
        const client = server(
            { terminalId: 'terminal-1', accepted: true, byteLength: 2, enter: false },
            'terminal.send',
        );

        await expect(
            runCli(
                [
                    'terminal',
                    'send',
                    '--terminal',
                    'terminal-1',
                    '--text',
                    'ls',
                    '--profile',
                    '/profiles/selected',
                    '--yes',
                    '--quiet',
                ],
                { connect: () => Promise.resolve(client), io: output.io },
            ),
        ).resolves.toBe(0);
        expect(output.stdout()).toBe('terminal-1\n');
    });

    it('refuses --quiet before running a mutation that has no stable ID', async () => {
        const output = io();
        const connect = vi.fn();

        await expect(
            runCli(['host', 'stop', '--profile', '/profiles/selected', '--yes', '--quiet'], {
                connect,
                io: output.io,
            }),
        ).resolves.toBe(2);
        expect(connect).not.toHaveBeenCalled();
        expect(output.stderr()).toContain('--json');
    });

    it('still prints an empty Agent list', async () => {
        const output = io();
        const client = server({ agents: [] }, 'agent.list');

        await expect(
            runCli(['agent', 'list', '--quiet'], {
                connect: () => Promise.resolve(client),
                io: output.io,
            }),
        ).resolves.toBe(0);
        expect(output.stdout()).toBe('\n');
    });

    it('prints each Agent as the Endpoint reference other agent commands accept', async () => {
        const output = io();
        const client = server(
            { agents: [agentEndpoint('endpoint-1', 2), agentEndpoint('endpoint-2', 1)] },
            'agent.list',
        );

        await expect(
            runCli(['agent', 'list', '--quiet'], {
                connect: () => Promise.resolve(client),
                io: output.io,
            }),
        ).resolves.toBe(0);
        expect(output.stdout()).toBe('host-1:endpoint-1:2\nhost-1:endpoint-2:1\n');
    });

    it('prints one Session ID per board row', async () => {
        const output = io();
        const client = server(
            { rows: [{ sessionId: 'session-1' }, { sessionId: 'session-2' }] },
            'bot.board',
        );

        await expect(
            runCli(['bot', 'board', '--quiet'], {
                connect: () => Promise.resolve(client),
                io: output.io,
            }),
        ).resolves.toBe(0);
        expect(output.stdout()).toBe('session-1\nsession-2\n');
    });
});
