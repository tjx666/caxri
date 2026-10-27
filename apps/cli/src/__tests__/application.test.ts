// eslint-disable-next-line unicorn/name-replacements -- this file tests `application.ts`, the CLI composition root's documented name (see project-architecture: the package root remains the composition root of application, environment, output, and selectors); renaming it would contradict that architecture contract.
import { CAXRI_PROTOCOL_VERSION, CaxriError } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { runCli } from '../application';
import { io, server } from './cli-test-support';

describe('CLI application', () => {
    it('renders top-level and group help without connecting to a Host', async () => {
        const output = io();
        const connect = vi.fn();

        await expect(runCli(['--help'], { connect, io: output.io })).resolves.toBe(0);
        expect(output.stdout()).toContain('Usage: caxri <command> [options]');
        expect(output.stdout()).toContain('host');
        expect(output.stdout()).toContain('open');
        expect(output.stdout()).toContain('reveal');
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
        const serverStatus = parsed.commands.find((command) => command.method === 'host.status');
        expect(typeof serverStatus?.paramsSchema).toBe('object');
        expect(typeof serverStatus?.resultSchema).toBe('object');
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

    it('projects top-level status through negotiation without expanding Agent authority', async () => {
        const output = io();
        const client = server({}, ['agent.context']);
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

        await expect(
            runCli(['status', '--json'], {
                connect: () => Promise.resolve(client),
                environment: {
                    CAXRI_AGENT_ENDPOINT_GENERATION: '2',
                    CAXRI_AGENT_ENDPOINT_HOST_ID: 'a'.repeat(32),
                    CAXRI_AGENT_ENDPOINT_ID: 'endpoint-1',
                    CAXRI_AGENT_ENDPOINT_TOKEN: 'ab'.repeat(32),
                    CAXRI_USER_DATA_DIR: '/profiles/agent',
                },
                io: output.io,
            }),
        ).resolves.toBe(0);

        expect(JSON.parse(output.stdout())).toMatchObject({
            capabilities: ['agents.read'],
            principal: { kind: 'agent', endpointId: 'endpoint-1', generation: 2 },
            protocolVersion: CAXRI_PROTOCOL_VERSION,
            status: 'ready',
        });
        expect(client.request).not.toHaveBeenCalledWith('host.status', {});
        expect(output.stdout()).not.toContain('profileId');
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
        const client = server({
            profileId: 'profile-1',
            version: '0.0.6',
            pid: 10,
            startedAt: 1,
            clientCount: 1,
            activePtyCount: 0,
            protocolVersion: 2,
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
        const client = server({}, []);

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

    it('requires an explicit profile for non-interactive mutations and shows the exact command', async () => {
        const output = io({ stdinIsTTY: false, stdoutIsTTY: false });
        const connect = vi.fn();

        await expect(
            runCli(['host', 'stop', '--yes'], { connect, home: '/home/me', io: output.io }),
        ).resolves.toBe(2);
        expect(connect).not.toHaveBeenCalled();
        expect(output.stderr()).toContain('--profile');
        expect(output.stderr()).toContain('caxri host stop --yes --profile');
    });

    it('executes a confirmed mutation and never mixes progress into JSON stdout', async () => {
        const output = io({ stdinIsTTY: false, stdoutIsTTY: false });
        const client = server({ state: 'stopped' });

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
        ['NOT_FOUND', 3, 'No Caxri Server is running'],
        ['UNAVAILABLE', 6, 'Caxri Server is starting'],
        ['CONFLICT', 4, 'Caxri Server protocol version is incompatible'],
        ['TIMEOUT', 7, 'Caxri Server request timed out'],
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

    it('queries shared Project projections and emits only IDs in quiet mode', async () => {
        const output = io();
        const client = server(
            {
                view: 'human-cli',
                projects: [{ id: 'project-1', title: 'Caxri', rootPath: '$HOME/code/caxri' }],
            },
            ['project.query'],
        );

        await expect(
            runCli(['project', 'list', '--quiet'], {
                connect: () => Promise.resolve(client),
                io: output.io,
            }),
        ).resolves.toBe(0);

        expect(client.request).toHaveBeenCalledWith('project.query', { mode: 'list' });
        expect(output.stdout()).toBe('project-1\n');
    });

    it('validates a Settings patch without mutation confirmation', async () => {
        const output = io({ stdinIsTTY: false });
        const client = server(
            {
                value: { 'terminal.fontSize': 17 },
                revision: 'a'.repeat(64),
                errors: [],
                dryRun: true,
                changedKeys: ['terminal.fontSize'],
            },
            ['settings.patch'],
        );

        await expect(
            runCli(['settings', 'validate', '--set', 'terminal.fontSize=17', '--json'], {
                connect: () => Promise.resolve(client),
                io: output.io,
            }),
        ).resolves.toBe(0);

        expect(client.request).toHaveBeenCalledWith('settings.patch', {
            changes: [{ key: 'terminal.fontSize', value: 17 }],
            dryRun: true,
        });
    });

    it('sends an explicit request ID for an accepted Settings mutation', async () => {
        const output = io({ stdinIsTTY: false });
        const client = server(
            {
                value: { 'terminal.fontSize': 18 },
                revision: 'b'.repeat(64),
                errors: [],
                dryRun: false,
                changedKeys: ['terminal.fontSize'],
            },
            ['settings.patch'],
        );

        await expect(
            runCli(
                [
                    'settings',
                    'patch',
                    '--set',
                    'terminal.fontSize=18',
                    '--request-id',
                    'settings-18',
                    '--profile',
                    '/profiles/selected',
                    '--yes',
                    '--json',
                ],
                { connect: () => Promise.resolve(client), io: output.io },
            ),
        ).resolves.toBe(0);

        expect(client.requestWithId).toHaveBeenCalledWith('settings-18', 'settings.patch', {
            changes: [{ key: 'terminal.fontSize', value: 18 }],
            dryRun: false,
        });
        expect(client.request).not.toHaveBeenCalled();
    });

    it('routes an explicit Desktop file open through the shared Host command', async () => {
        const output = io({ stdinIsTTY: false });
        const client = server(
            {
                state: 'requested',
                generation: 3,
                projectId: 'project-1',
                sessionId: 'session-1',
            },
            ['desktop.openPath'],
        );

        await expect(
            runCli(
                [
                    'open',
                    '/project/file.ts',
                    '--session',
                    'session-1',
                    '--no-launch',
                    '--profile',
                    '/profiles/selected',
                    '--request-id',
                    'open-file-1',
                    '--yes',
                    '--json',
                ],
                { connect: () => Promise.resolve(client), io: output.io },
            ),
        ).resolves.toBe(0);

        expect(client.requestWithId).toHaveBeenCalledWith('open-file-1', 'desktop.openPath', {
            launchIfNeeded: false,
            path: '/project/file.ts',
            sessionId: 'session-1',
        });
        expect(JSON.parse(output.stdout())).toMatchObject({
            state: 'requested',
            projectId: 'project-1',
            sessionId: 'session-1',
        });
    });

    it('backs off idle log polling and resets after output without exposing log fields', async () => {
        const output = io({ stdinIsTTY: false, stdoutIsTTY: false });
        const controller = new AbortController();
        const client = server({}, ['logs.query']);
        const pages = [
            { records: [], nextCursor: 'cursor-1', gap: false, truncated: false },
            { records: [], nextCursor: 'cursor-2', gap: false, truncated: false },
            {
                records: [
                    {
                        id: 'record-1',
                        timestamp: '2026-08-14T00:00:00.000Z',
                        process: 'server-core',
                        level: 'info',
                        event: 'server_core.ready',
                    },
                ],
                nextCursor: 'cursor-3',
                gap: false,
                truncated: false,
            },
        ];
        client.request = vi.fn(() =>
            Promise.resolve(
                pages.shift() ?? {
                    records: [],
                    nextCursor: 'cursor-4',
                    gap: false,
                    truncated: false,
                },
            ),
        );
        const waits: number[] = [];

        await expect(
            runCli(['logs', 'follow', '--json'], {
                connect: () => Promise.resolve(client),
                io: output.io,
                signal: controller.signal,
                wait: (milliseconds) => {
                    waits.push(milliseconds);
                    if (waits.length === 4) controller.abort();
                    return Promise.resolve();
                },
            }),
        ).resolves.toBe(130);

        expect(output.stdout()).toBe(
            '{"event":"server_core.ready","id":"record-1","level":"info","process":"server-core","timestamp":"2026-08-14T00:00:00.000Z"}\n',
        );
        expect(waits).toEqual([250, 500, 250, 250]);
        expect(output.stdout()).not.toContain('fields');
    });

    it('watches projected event names without receiving Desktop event payloads', async () => {
        const output = io({ stdinIsTTY: false, stdoutIsTTY: false });
        const controller = new AbortController();
        const client = server(
            {
                kind: 'events',
                cursor: 1,
                events: [{ cursor: 1, event: 'settings.changed' }],
            },
            ['events.query'],
        );

        await expect(
            runCli(['events', 'watch', '--json'], {
                connect: () => Promise.resolve(client),
                io: output.io,
                signal: controller.signal,
                wait: () => {
                    controller.abort();
                    return Promise.resolve();
                },
            }),
        ).resolves.toBe(130);

        expect(client.request).toHaveBeenCalledWith('events.query', { afterCursor: 0 });
        expect(output.stdout()).toBe('{"cursor":1,"event":"settings.changed"}\n');
        expect(output.stdout()).not.toContain('source');
    });
});
