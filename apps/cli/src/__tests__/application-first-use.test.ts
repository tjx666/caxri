// eslint-disable-next-line unicorn/name-replacements -- this file tests `application.ts`, the CLI composition root's documented name (see project-architecture); renaming it would contradict that architecture contract.
import type { ProtocolWelcome } from '@caxri/protocol';
import { CAXRI_PROTOCOL_VERSION, CaxriError } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { CliIo, CliServerClient } from '../application';
import { runCli } from '../application';

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

function server(result: unknown, commands = ['host.status', 'host.stop']): CliServerClient {
    return {
        close: vi.fn(),
        request: vi.fn(() => Promise.resolve(result)),
        requestWithId: vi.fn(() => Promise.resolve(result)),
        welcome: {
            protocolVersion: CAXRI_PROTOCOL_VERSION,
            principal: { kind: 'human-cli', id: 'cli-test' },
            capabilities: ['host.read', 'host.stop'],
            commands,
        } satisfies ProtocolWelcome,
    };
}

describe('CLI first-use experience', () => {
    it('lets an interactive terminal mutate the default profile without --profile', async () => {
        const output = io();
        const client = server({ state: 'stopped' });

        await expect(
            runCli(['host', 'stop', '--yes'], {
                connect: () => Promise.resolve(client),
                io: output.io,
            }),
        ).resolves.toBe(0);
        expect(client.request).toHaveBeenCalledWith('host.stop', { confirmLivePtys: false });
    });

    it('keeps the explicit profile requirement for automated callers on a TTY', async () => {
        const output = io();
        const connect = vi.fn();

        await expect(
            runCli(['host', 'stop', '--yes'], {
                connect,
                environment: { CLAUDECODE: '1' },
                io: output.io,
            }),
        ).resolves.toBe(2);
        expect(connect).not.toHaveBeenCalled();
    });

    it('names the next step when no Server is running', async () => {
        const output = io();

        await expect(
            runCli(['host', 'status'], {
                connect: () =>
                    Promise.reject(
                        new CaxriError('NOT_FOUND', 'No Caxri Server is running for this profile'),
                    ),
                io: output.io,
            }),
        ).resolves.toBe(3);
        expect(output.stderr()).toContain("Caxri isn't running");
        expect(output.stderr()).toContain('caxri desktop focus --launch');
    });

    it('renders Project lists as readable tables in human mode only', async () => {
        const result = {
            view: 'human-cli',
            projects: [{ id: 'p1', displayTitle: 'Demo', rootPath: '/work/demo' }],
        };
        const human = io();
        await expect(
            runCli(['project', 'list'], {
                connect: () => Promise.resolve(server(result, ['project.query'])),
                io: human.io,
            }),
        ).resolves.toBe(0);
        expect(human.stdout()).toContain('TITLE');
        expect(human.stdout()).toContain('/work/demo');
        expect(human.stdout()).not.toContain('human-cli');

        const json = io();
        await runCli(['project', 'list', '--json'], {
            connect: () => Promise.resolve(server(result, ['project.query'])),
            io: json.io,
        });
        expect(JSON.parse(json.stdout())).toEqual(result);
    });

    it('lists common tasks in top-level help', async () => {
        const output = io();
        await runCli(['--help'], { io: output.io });
        expect(output.stdout()).toContain('Common tasks:');
        expect(output.stdout()).toContain('caxri open .');
        expect(output.stdout().indexOf('capabilities')).toBeGreaterThan(
            output.stdout().indexOf('terminal'),
        );
    });
});
