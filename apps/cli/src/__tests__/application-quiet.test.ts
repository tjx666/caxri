// eslint-disable-next-line unicorn/name-replacements -- this file tests `application.ts`, the CLI composition root's documented name (see project-architecture).
import type { ProtocolWelcome } from '@caxri/protocol';
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
            capabilities: ['commander'],
            commands: [method],
        } satisfies ProtocolWelcome,
    };
}

/**
 * `--quiet` prints after the request already ran, so a projection that cannot find the ID turns a Session that was
 * created into a `VALIDATION` exit, and a retry creates a second one.
 */
describe('Agent Commander quiet output', () => {
    it('prints the created Session ID and exits 0', async () => {
        const output = io();
        const client = server(
            { projectId: 'project-1', sessionId: 'session-1' },
            'commander.session.create',
        );

        await expect(
            runCli(
                [
                    'commander',
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

    it('prints one Session ID per board row', async () => {
        const output = io();
        const client = server(
            { rows: [{ sessionId: 'session-1' }, { sessionId: 'session-2' }] },
            'commander.board',
        );

        await expect(
            runCli(['commander', 'board', '--quiet'], {
                connect: () => Promise.resolve(client),
                io: output.io,
            }),
        ).resolves.toBe(0);
        expect(output.stdout()).toBe('session-1\nsession-2\n');
    });
});
