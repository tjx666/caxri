// eslint-disable-next-line unicorn/name-replacements -- this file tests `application.ts`, the CLI composition root's documented name (see project-architecture).
import type { ProtocolWelcome } from '@caxri/protocol';
import { CAXRI_PROTOCOL_VERSION, MAX_DELEGATION_WAIT_TIMEOUT_MS } from '@caxri/protocol';
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
            capabilities: ['agents.delegate'],
            commands: [method],
        } satisfies ProtocolWelcome,
    };
}

describe('CLI --timeout ceilings', () => {
    it('accepts the delegation wait schema ceiling as --timeout without stretching the connect deadline', async () => {
        const client = server({ outcome: 'timeout' }, 'agent.delegation.wait');
        const connect = vi.fn(() => Promise.resolve(client));
        const output = io();

        await runCli(
            [
                'agent',
                'delegate',
                'wait',
                'task-1',
                '--timeout',
                String(MAX_DELEGATION_WAIT_TIMEOUT_MS),
                '--json',
            ],
            { connect, environment: { CODEX_THREAD_ID: 'thread-1' }, io: output.io },
        );
        expect(output.stderr()).not.toContain('--timeout');
        expect(connect).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 120_000 }));
        expect(client.request).toHaveBeenCalledWith('agent.delegation.wait', {
            delegationId: 'task-1',
            timeoutMs: MAX_DELEGATION_WAIT_TIMEOUT_MS,
        });

        const above = io();
        await expect(
            runCli(
                [
                    'agent',
                    'delegate',
                    'wait',
                    'task-1',
                    '--timeout',
                    String(MAX_DELEGATION_WAIT_TIMEOUT_MS + 1),
                    '--json',
                ],
                { connect, io: above.io },
            ),
        ).resolves.not.toBe(0);
        expect(above.stderr()).toContain(
            `--timeout must be 100-${MAX_DELEGATION_WAIT_TIMEOUT_MS} milliseconds`,
        );
    });

    it('keeps the 120-second --timeout ceiling on commands without a longer long poll', async () => {
        const connect = vi.fn();
        const output = io();

        await expect(
            runCli(['agent', 'message', 'wait', '--timeout', '120001', '--json'], {
                connect,
                io: output.io,
            }),
        ).resolves.not.toBe(0);
        expect(connect).not.toHaveBeenCalled();
        expect(output.stderr()).toContain('--timeout must be 100-120000 milliseconds');
    });
});
