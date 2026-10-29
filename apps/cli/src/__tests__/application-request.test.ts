// eslint-disable-next-line unicorn/name-replacements -- this file tests `application.ts`, the CLI composition root's documented name (see project-architecture).
import type { Capability, ProtocolWelcome } from '@caxri/protocol';
import { CAXRI_PROTOCOL_VERSION } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { CliServerClient } from '../application';
import { runCli } from '../application';
import { io } from './cli-test-support';

function client(
    result: unknown,
    options: {
        capabilities?: Capability[];
        commands?: string[];
        principal?: ProtocolWelcome['principal'];
    } = {},
): CliServerClient {
    return {
        close: vi.fn(),
        request: vi.fn(() => Promise.resolve(result)),
        requestWithId: vi.fn(() => Promise.resolve(result)),
        welcome: {
            protocolVersion: CAXRI_PROTOCOL_VERSION,
            principal: options.principal ?? { kind: 'human-cli', id: 'cli-test' },
            capabilities: options.capabilities ?? ['sessions.read', 'settings.write'],
            commands: options.commands ?? ['session.query', 'settings.patch'],
        } satisfies ProtocolWelcome,
    };
}

async function run(argv: string[], server: CliServerClient, extra = {}) {
    const output = io({ stdinIsTTY: false, stdoutIsTTY: false });
    const code = await runCli(argv, {
        connect: () => Promise.resolve(server),
        environment: {},
        io: output.io,
        ...extra,
    });
    return { code, stderr: output.stderr(), stdout: output.stdout() };
}

describe('caxri request', () => {
    it('calls a read method with validated params and prints the result as JSON', async () => {
        const server = client({ sessions: [] });
        const result = await run(
            ['request', 'session.query', '--params', '{"mode":"list"}', '--json'],
            server,
        );

        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({ sessions: [] });
        expect(server.request).toHaveBeenCalledWith('session.query', { mode: 'list' });
    });

    it('reads params from stdin with --params -', async () => {
        const server = client({ sessions: [] });
        const result = await run(['request', 'session.query', '--params', '-', '--json'], server, {
            readStdin: () => Promise.resolve('{"mode":"current"}'),
        });

        expect(result.code).toBe(0);
        expect(server.request).toHaveBeenCalledWith('session.query', { mode: 'current' });
    });

    it('rejects an unknown method, invalid JSON, and schema-invalid params as VALIDATION', async () => {
        const server = client({});
        const unknown = await run(['request', 'nope.method', '--json'], server);
        const badJson = await run(
            ['request', 'session.query', '--params', '{oops', '--json'],
            server,
        );
        const badSchema = await run(
            ['request', 'session.query', '--params', '{"mode":"bogus"}', '--json'],
            server,
        );

        for (const result of [unknown, badJson, badSchema]) {
            expect(result.code).toBe(2);
            expect((JSON.parse(result.stderr) as { code: string }).code).toBe('VALIDATION');
        }
        expect(unknown.stderr).toContain('Unknown Server method');
        expect(badJson.stderr).toContain('not valid JSON');
        expect(badSchema.stderr).toContain('Invalid params for session.query');
        expect(server.request).not.toHaveBeenCalled();
    });

    it('requires --yes for a non-read method outside an interactive terminal', async () => {
        const server = client({});
        const result = await run(
            [
                'request',
                'settings.patch',
                '--params',
                '{"changes":[{"key":"terminal.fontSize","value":14}]}',
                '--profile',
                '/tmp/profile',
                '--json',
            ],
            server,
        );

        expect(result.code).toBe(2);
        expect(result.stderr).toContain('--yes');
        expect(server.request).not.toHaveBeenCalled();
    });

    it('reports FORBIDDEN when the caller lacks the method capability', async () => {
        const server = client({}, { capabilities: ['projects.read'], commands: [] });
        const result = await run(
            ['request', 'session.query', '--params', '{"mode":"list"}', '--json'],
            server,
        );

        expect(result.code).toBe(5);
        expect((JSON.parse(result.stderr) as { code: string }).code).toBe('FORBIDDEN');
        expect(server.request).not.toHaveBeenCalled();
    });

    it('refuses an owner-only method for an Agent Endpoint credential', async () => {
        const server = client({});
        const result = await run(
            [
                'request',
                'agentChat.continueInAgent',
                '--params',
                '{"terminalId":"t1","provider":"codex"}',
                '--yes',
                '--json',
            ],
            server,
            {
                environment: {
                    CAXRI_AGENT_ENDPOINT_HOST_ID: 'a'.repeat(32),
                    CAXRI_AGENT_ENDPOINT_ID: 'endpoint-1',
                    CAXRI_AGENT_ENDPOINT_GENERATION: '2',
                    CAXRI_AGENT_ENDPOINT_TOKEN: 'ab'.repeat(32),
                    CAXRI_USER_DATA_DIR: '/profiles/agent',
                },
            },
        );

        expect(result.code).toBe(5);
        expect(server.request).not.toHaveBeenCalled();
    });
});
