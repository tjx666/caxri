// eslint-disable-next-line unicorn/name-replacements -- this file tests `application.ts`, the CLI composition root's documented name (see project-architecture).
import process from 'node:process';

import type { CaxriMethod } from '@caxri/protocol';
import { CAXRI_PROTOCOL_VERSION } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { CliServerClient } from '../application';
import { runCli } from '../application';
import { io } from './cli-test-support';

const SYNTHETIC_SECRET = 'synthetic-value-for-tests';

const agentEnvironment = {
    CODEX_THREAD_ID: 'thread-1',
    CAXRI_AGENT_ENDPOINT_HOST_ID: 'a'.repeat(32),
    CAXRI_AGENT_ENDPOINT_ID: 'endpoint-1',
    CAXRI_AGENT_ENDPOINT_GENERATION: '2',
    CAXRI_AGENT_ENDPOINT_TOKEN: 'ab'.repeat(32),
    CAXRI_USER_DATA_DIR: '/profiles/agent',
    PATH: process.env.PATH,
};

function agentServer(respond: (method: CaxriMethod, parameters: unknown) => unknown) {
    const request = vi.fn((method: CaxriMethod, parameters: unknown) =>
        Promise.resolve(respond(method, parameters)),
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
            capabilities: ['secrets.use'],
            commands: [
                'agent.secret.list',
                'agent.secret.request',
                'agent.secret.wait',
                'agent.secret.resolve',
            ],
        },
    };
    return { client, request };
}

describe('caxri secret', () => {
    it('runs the command with the secret in its environment and passes its exit code through', async () => {
        const output = io();
        const { client, request } = agentServer(() => ({
            values: { API_TOKEN: SYNTHETIC_SECRET },
        }));
        /**
         * Exits 7 only when the secret arrived and the child's own `--json` reached it instead of Caxri.
         */
        const script = `process.exit(process.env.API_TOKEN === ${JSON.stringify(SYNTHETIC_SECRET)} && process.argv.includes('--json') ? 7 : 1)`;

        await expect(
            runCli(
                [
                    'secret',
                    'exec',
                    'API_TOKEN',
                    '--',
                    process.execPath,
                    '-e',
                    script,
                    '--',
                    '--json',
                ],
                {
                    connect: () => Promise.resolve(client),
                    environment: agentEnvironment,
                    io: output.io,
                },
            ),
        ).resolves.toBe(7);

        expect(request).toHaveBeenCalledWith('agent.secret.resolve', { names: ['API_TOKEN'] });
        expect(`${output.stdout()}${output.stderr()}`).not.toContain(SYNTHETIC_SECRET);
    });

    it('reports a missing command without starting anything', async () => {
        const output = io();
        const { client } = agentServer(() => ({ values: { API_TOKEN: SYNTHETIC_SECRET } }));

        await expect(
            runCli(['secret', 'exec', 'API_TOKEN', '--', 'caxri-test-missing-command'], {
                connect: () => Promise.resolve(client),
                environment: agentEnvironment,
                io: output.io,
            }),
        ).resolves.toBe(3);
        expect(output.stderr()).toContain('Command not found: caxri-test-missing-command');
    });

    it('waits for the user to answer a request, polling until it settles', async () => {
        const output = io();
        const statuses = ['pending', 'saved'];
        const { client, request } = agentServer((method) => {
            if (method === 'agent.secret.request') return { status: 'pending', requestId: 'r1' };
            return { status: statuses.shift() };
        });

        await expect(
            runCli(['secret', 'request', 'API_TOKEN', '--reason', 'Deploy preview', '--json'], {
                connect: () => Promise.resolve(client),
                environment: agentEnvironment,
                io: output.io,
            }),
        ).resolves.toBe(0);

        expect(request).toHaveBeenCalledWith('agent.secret.request', {
            name: 'API_TOKEN',
            reason: 'Deploy preview',
        });
        expect(
            request.mock.calls.filter(([method]) => method === 'agent.secret.wait'),
        ).toHaveLength(2);
        expect(output.stdout()).toBe('{"name":"API_TOKEN","status":"saved"}\n');
    });

    it('tells the Agent when the user declines', async () => {
        const output = io();
        const { client } = agentServer((method) =>
            method === 'agent.secret.request'
                ? { status: 'pending', requestId: 'r1' }
                : { status: 'declined' },
        );

        await expect(
            runCli(['secret', 'request', 'API_TOKEN', '--reason', 'Deploy preview'], {
                connect: () => Promise.resolve(client),
                environment: agentEnvironment,
                io: output.io,
            }),
        ).resolves.toBe(4);
        expect(output.stderr()).toContain('The user declined to provide API_TOKEN');
    });

    it('returns at once when the secret already exists', async () => {
        const output = io();
        const { client, request } = agentServer(() => ({ status: 'available' }));

        await expect(
            runCli(['secret', 'request', 'API_TOKEN', '--reason', 'Deploy preview', '--json'], {
                connect: () => Promise.resolve(client),
                environment: agentEnvironment,
                io: output.io,
            }),
        ).resolves.toBe(0);
        expect(request).toHaveBeenCalledTimes(1);
        expect(output.stdout()).toBe('{"name":"API_TOKEN","status":"available"}\n');
    });

    it('refuses a caller without a managed Agent Endpoint', async () => {
        const output = io();
        const { client, request } = agentServer(() => ({ values: {} }));

        await expect(
            runCli(['secret', 'exec', 'API_TOKEN', '--', 'true'], {
                connect: () => Promise.resolve(client),
                environment: { CAXRI_USER_DATA_DIR: '/profiles/agent' },
                io: output.io,
            }),
        ).resolves.toBe(5);
        expect(request).not.toHaveBeenCalled();
    });
});
