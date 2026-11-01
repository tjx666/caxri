// eslint-disable-next-line unicorn/name-replacements -- this file tests `application.ts`, the CLI composition root's documented name (see project-architecture).
import process from 'node:process';

import type { CaxriMethod } from '@caxri/protocol';
import { CAXRI_PROTOCOL_VERSION, DEVICE_EXEC_MAX_TIMEOUT_MS } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { CliServerClient } from '../application';
import { runCli } from '../application';
import { io } from './cli-test-support';

const agentEnvironment = {
    CODEX_THREAD_ID: 'thread-1',
    CAXRI_AGENT_ENDPOINT_HOST_ID: 'a'.repeat(32),
    CAXRI_AGENT_ENDPOINT_ID: 'endpoint-1',
    CAXRI_AGENT_ENDPOINT_GENERATION: '2',
    CAXRI_AGENT_ENDPOINT_TOKEN: 'ab'.repeat(32),
    CAXRI_USER_DATA_DIR: '/profiles/agent',
    PATH: process.env.PATH,
};

function agentServer(result: unknown) {
    const request = vi.fn<(method: CaxriMethod, parameters: unknown) => Promise<unknown>>(() =>
        Promise.resolve(result),
    );
    const client: CliServerClient = {
        close: vi.fn(),
        request,
        requestWithId: vi.fn(),
        welcome: {
            protocolVersion: CAXRI_PROTOCOL_VERSION,
            principal: {
                kind: 'agent',
                id: 'agent:endpoint-1',
                endpointId: 'endpoint-1',
                generation: 2,
                projectIds: ['project-1'],
            },
            capabilities: ['devices.control'],
            commands: [
                'mobile.deviceAction.targets',
                'mobile.deviceAction.openUrl',
                'mobile.deviceAction.exec',
            ],
        },
    };
    return { client, request };
}

/**
 * A person at an interactive terminal gets plain output; an Agent gets `--json` by default.
 */
const humanEnvironment = { HOME: '/Users/me', PATH: process.env.PATH };

const run = (
    argv: string[],
    client: CliServerClient,
    output = io(),
    environment: NodeJS.ProcessEnv = humanEnvironment,
) =>
    runCli(environment === humanEnvironment ? ['--profile', '/profiles/selected', ...argv] : argv, {
        connect: () => Promise.resolve(client),
        environment,
        io: output.io,
    });

const exited = {
    deviceId: 'device-1',
    exitCode: 3,
    stdout: 'out\n',
    stderr: 'err\n',
    truncated: false,
};

describe('caxri device', () => {
    it('runs a phone command, keeping its own flags, and passes output and exit code through', async () => {
        const output = io();
        const { client, request } = agentServer(exited);

        await expect(
            run(
                [
                    'device',
                    'exec',
                    '--device',
                    'device-1',
                    '--cwd',
                    '~/src',
                    '--',
                    'ls',
                    '--json',
                    '-la',
                ],
                client,
                output,
            ),
        ).resolves.toBe(3);

        expect(request).toHaveBeenCalledWith('mobile.deviceAction.exec', {
            argv: ['ls', '--json', '-la'],
            cwd: '~/src',
            deviceId: 'device-1',
            timeoutMs: 15_000,
        });
        expect(output.stdout()).toBe('out\n');
        expect(output.stderr()).toBe('err\n');
    });

    it('maps --timeout to the command deadline up to its own ceiling', async () => {
        const { client, request } = agentServer({ ...exited, exitCode: 0 });

        await expect(
            run(
                [
                    'device',
                    'exec',
                    '--timeout',
                    String(DEVICE_EXEC_MAX_TIMEOUT_MS),
                    '--',
                    'sleep',
                    '500',
                ],
                client,
            ),
        ).resolves.toBe(0);
        expect(request.mock.calls[0][1]).toMatchObject({ timeoutMs: DEVICE_EXEC_MAX_TIMEOUT_MS });
        await expect(
            run(
                [
                    'device',
                    'exec',
                    '--timeout',
                    String(DEVICE_EXEC_MAX_TIMEOUT_MS + 1),
                    '--',
                    'true',
                ],
                client,
            ),
        ).resolves.not.toBe(0);
    });

    it('prints the whole result as JSON for an Agent and exits 0', async () => {
        const output = io();
        const { client } = agentServer(exited);

        await expect(
            run(['device', 'exec', '--', 'true'], client, output, agentEnvironment),
        ).resolves.toBe(0);
        expect(JSON.parse(output.stdout())).toEqual(exited);
    });

    it('rejects an exec without a command and an open without one URL, before connecting', async () => {
        const { client, request } = agentServer(exited);

        await expect(run(['device', 'exec', '--device', 'device-1'], client)).resolves.not.toBe(0);
        await expect(run(['device', 'open'], client)).resolves.not.toBe(0);
        await expect(
            run(['device', 'open', '--force', 'https://example.com'], client),
        ).resolves.not.toBe(0);
        expect(request).not.toHaveBeenCalled();
    });

    it('opens a link on the named phone', async () => {
        const { client, request } = agentServer({ deviceId: 'device-1' });

        await expect(
            run(['device', 'open', 'https://example.com/a', '--device', 'device-1'], client),
        ).resolves.toBe(0);
        expect(request).toHaveBeenCalledWith('mobile.deviceAction.openUrl', {
            deviceId: 'device-1',
            url: 'https://example.com/a',
        });
    });
});
