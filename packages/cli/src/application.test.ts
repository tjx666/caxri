import { describe, expect, it, vi } from 'vitest';

import { CaxriError, CAXRI_PROTOCOL_VERSION, type ProtocolWelcome } from '@caxri/protocol';

import { runCli, type CliHostClient, type CliIo } from './application';

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

function host(
    result: unknown,
    commands = ['host.status', 'host.stop', 'desktop.status', 'desktop.focus'],
): CliHostClient {
    return {
        close: vi.fn(),
        request: vi.fn(() => Promise.resolve(result)),
        welcome: {
            protocolVersion: CAXRI_PROTOCOL_VERSION,
            principal: { kind: 'human-cli', id: 'cli-test' },
            capabilities: ['desktop.window', 'host.read', 'host.stop'],
            commands,
        } satisfies ProtocolWelcome,
    };
}

describe('CLI application', () => {
    it('renders top-level and group help without connecting to a Host', async () => {
        const output = io();
        const connect = vi.fn();

        await expect(runCli(['--help'], { connect, io: output.io })).resolves.toBe(0);
        expect(output.stdout()).toContain('Usage: caxri <command> [options]');
        expect(output.stdout()).toContain('host');
        expect(output.stdout()).toContain('skills');
        expect(connect).not.toHaveBeenCalled();

        const group = io();
        await expect(runCli(['host', '--help'], { connect, io: group.io })).resolves.toBe(0);
        expect(group.stdout()).toContain('Usage: caxri host <command>');
        expect(group.stdout()).toContain('status');
    });

    it('derives offline JSON introspection from the shared command registry', async () => {
        const output = io();
        const connect = vi.fn();

        await expect(runCli(['capabilities', '--json'], { connect, io: output.io })).resolves.toBe(
            0,
        );
        const parsed = JSON.parse(output.stdout()) as {
            commands: Array<{
                capabilities?: string[];
                effect?: string;
                method?: string;
                paramsSchema?: unknown;
                path: string[];
                resultSchema?: unknown;
            }>;
            protocolMethods: Array<{ method: string }>;
        };
        expect(parsed.commands).toContainEqual(
            expect.objectContaining({
                path: ['host', 'status'],
                method: 'host.status',
                effect: 'read',
                capabilities: ['host.read'],
            }),
        );
        const hostStatus = parsed.commands.find((command) => command.method === 'host.status');
        expect(typeof hostStatus?.paramsSchema).toBe('object');
        expect(typeof hostStatus?.resultSchema).toBe('object');
        expect(parsed.protocolMethods).toContainEqual(
            expect.objectContaining({ method: 'settings.get' }),
        );
        expect(connect).not.toHaveBeenCalled();
        expect(output.stderr()).toBe('');
    });

    it('prints stable protocol method IDs for quiet offline introspection', async () => {
        const output = io();

        await expect(runCli(['capabilities', '--quiet'], { io: output.io })).resolves.toBe(0);
        expect(output.stdout()).toContain('host.status\n');
        expect(output.stdout()).toContain('settings.get\n');
        expect(output.stderr()).toBe('');
    });

    it('defaults supported Agent and CI environments to JSON without exposing profile paths', async () => {
        const output = io();

        await expect(
            runCli(['agent-context'], {
                environment: { CODEX_THREAD_ID: 'thread-1', HOME: '/Users/private' },
                io: output.io,
            }),
        ).resolves.toBe(0);
        expect(output.stdout()).toContain('"automation":"agent"');
        expect(output.stdout()).not.toContain('/Users/private');
    });

    it('negotiates the command with the selected profile and emits stable JSON', async () => {
        const output = io();
        const client = host({
            profileId: 'profile-1',
            version: '0.0.6',
            pid: 10,
            runtimePid: 11,
            startedAt: 1,
            clientCount: 1,
            activePtyCount: 0,
            protocolVersion: 1,
            protocolCompatible: true,
            desktop: { state: 'offline' },
        });
        const connect = vi.fn(() => Promise.resolve(client));

        await expect(
            runCli(['host', 'status', '--profile', '/tmp/caxri-profile', '--json'], {
                connect,
                io: output.io,
            }),
        ).resolves.toBe(0);
        expect(connect).toHaveBeenCalledWith(
            expect.objectContaining({ profilePath: '/tmp/caxri-profile', timeoutMs: 15_000 }),
        );
        expect(client.request).toHaveBeenCalledWith('host.status', {});
        expect(output.stdout()).toContain('"profileId":"profile-1"');
        expect(client.close).toHaveBeenCalledOnce();
    });

    it('fails closed when negotiation does not advertise a selected command', async () => {
        const output = io();
        const client = host({}, []);

        await expect(
            runCli(['host', 'status', '--json'], {
                connect: () => Promise.resolve(client),
                io: output.io,
            }),
        ).resolves.toBe(4);
        expect(client.request).not.toHaveBeenCalled();
        expect(output.stdout()).toBe('');
        expect(output.stderr()).toContain('"code":"CONFLICT"');
    });

    it('requires explicit non-interactive confirmation before mutations', async () => {
        const output = io({ stdinIsTTY: false, stdoutIsTTY: false });
        const connect = vi.fn();

        await expect(
            runCli(['host', 'stop', '--profile', '/profiles/selected'], {
                connect,
                io: output.io,
            }),
        ).resolves.toBe(2);
        expect(connect).not.toHaveBeenCalled();
        expect(output.stderr()).toContain('--yes');
    });

    it('requires an explicit profile as the Host selector for mutations', async () => {
        const output = io();
        const connect = vi.fn();

        await expect(runCli(['host', 'stop', '--yes'], { connect, io: output.io })).resolves.toBe(
            2,
        );
        expect(connect).not.toHaveBeenCalled();
        expect(output.stderr()).toContain('--profile');
    });

    it('executes a confirmed mutation and never mixes progress into JSON stdout', async () => {
        const output = io({ stdinIsTTY: false, stdoutIsTTY: false });
        const client = host({ state: 'stopped' });

        await expect(
            runCli(['host', 'stop', '--yes', '--profile', '/profiles/selected', '--json'], {
                connect: () => Promise.resolve(client),
                io: output.io,
            }),
        ).resolves.toBe(0);
        expect(client.request).toHaveBeenCalledWith('host.stop', { confirmLivePtys: false });
        expect(output.stdout()).toBe('{"state":"stopped"}\n');
    });

    it('maps closed errors to stable exits and redacts unclassified failures', async () => {
        const unavailable = io();
        await expect(
            runCli(['host', 'status', '--json'], {
                connect: () => Promise.reject(new CaxriError('UNAVAILABLE', 'Host is starting')),
                io: unavailable.io,
            }),
        ).resolves.toBe(6);
        expect(unavailable.stderr()).toContain('"code":"UNAVAILABLE"');

        const internal = io();
        await expect(
            runCli(['host', 'status', '--json'], {
                connect: () =>
                    Promise.reject(
                        new Error(
                            'token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa /Users/private/secret',
                        ),
                    ),
                environment: { HOME: '/Users/private' },
                io: internal.io,
            }),
        ).resolves.toBe(10);
        expect(internal.stderr()).toContain('"code":"INTERNAL"');
        expect(internal.stderr()).not.toContain('aaaaaaaa');
        expect(internal.stderr()).not.toContain('/Users/private');
    });

    it.each([
        ['NOT_FOUND', 3, 'No Caxri Host is running'],
        ['UNAVAILABLE', 6, 'Caxri Host is starting'],
        ['CONFLICT', 4, 'Caxri Host protocol version is incompatible'],
        ['TIMEOUT', 7, 'Caxri Host request timed out'],
    ] as const)('maps %s Host negotiation failures to exit %i', async (code, exit, message) => {
        const output = io();

        await expect(
            runCli(['host', 'status', '--json'], {
                connect: () => Promise.reject(new CaxriError(code, message)),
                io: output.io,
            }),
        ).resolves.toBe(exit);
        expect(output.stdout()).toBe('');
        expect(output.stderr()).toContain(`"code":"${code}"`);
    });

    it('redacts sensitive closed-error details and the raw Home path', async () => {
        const output = io();

        await expect(
            runCli(['host', 'status', '--json'], {
                connect: () =>
                    Promise.reject(
                        new CaxriError('CONFLICT', 'Host at /Users/private/profile is stale', {
                            operatorToken: 'owner-token-sentinel',
                            path: '/Users/private/profile',
                        }),
                    ),
                environment: { HOME: '/Users/private' },
                io: output.io,
            }),
        ).resolves.toBe(4);
        expect(output.stderr()).toContain('$HOME/profile');
        expect(output.stderr()).not.toContain('owner-token-sentinel');
        expect(output.stderr()).not.toContain('/Users/private');
    });

    it('returns the conventional interrupt exit without contacting the Host', async () => {
        const output = io();
        const controller = new AbortController();
        controller.abort();
        const connect = vi.fn();

        await expect(
            runCli(['host', 'status'], { connect, io: output.io, signal: controller.signal }),
        ).resolves.toBe(130);
        expect(connect).not.toHaveBeenCalled();
    });
});
