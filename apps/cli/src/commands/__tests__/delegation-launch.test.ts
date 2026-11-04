import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { CaxriMethod, ProtocolWelcome } from '@caxri/protocol';
import { CAXRI_PROTOCOL_VERSION } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { CliConnectOptions, CliServerClient } from '../../application';
import { runCli } from '../../application';
import { launchParameters } from '../delegation-launch';

const grant = {
    clientId: 'd1decb80-7644-44fd-b821-a7d6678fb0eb',
    generation: 3,
    projectId: 'project-1',
    sessionId: 'session-1',
    callerProvider: 'codex',
    createdAt: 1,
    expiresAt: 2,
    token: 'cd'.repeat(32),
};

function launcher(projects: Array<{ id: string; rootPath: string; ownerProjectId?: string }> = []) {
    const events: string[] = [];
    const calls: Array<{ method: CaxriMethod; parameters: unknown }> = [];
    const request = vi.fn((method: CaxriMethod, parameters: unknown) => {
        calls.push({ method, parameters });
        events.push(method);
        if (method === 'project.list')
            return Promise.resolve({
                view: 'human-cli',
                projects: projects.map((p) => ({ title: 't', ...p })),
            });
        if (method === 'agent.delegation.access.revoke') return Promise.resolve({});
        return Promise.resolve(grant);
    });
    const client: CliServerClient = {
        close: vi.fn(() => {
            events.push('close');
        }),
        request,
        requestWithId: vi.fn(),
        welcome: {
            protocolVersion: CAXRI_PROTOCOL_VERSION,
            principal: { kind: 'human-cli', id: 'owner' },
            capabilities: ['agents.delegation.access', 'projects.read'],
            commands: ['agent.delegation.access.create'],
        } satisfies ProtocolWelcome,
    };
    const connect = vi.fn<(options: CliConnectOptions) => Promise<CliServerClient>>(() =>
        Promise.resolve(client),
    );
    let stdout = '';
    let stderr = '';
    const io = {
        writeStdout: (text: string) => {
            stdout += text;
        },
        writeStderr: (text: string) => {
            stderr += text;
        },
        stdinIsTTY: false,
        stdoutIsTTY: false,
        stderrIsTTY: false,
    };
    return {
        calls,
        client,
        connect,
        events,
        io,
        request,
        stderr: () => stderr,
        stdout: () => stdout,
    };
}

function canonicalTemporary(prefix: string): string {
    return realpathSync(mkdtempSync(`${tmpdir()}/${prefix}`));
}

const base = ['agent', 'delegate', 'access', 'launch', '--profile', '/profiles/owner', '--yes'];

describe('launchParameters', () => {
    it('derives the provider only from an exact standard executable name', () => {
        expect(launchParameters(['--', 'claude', '--model', 'x'])).toMatchObject({
            provider: 'claude',
            command: ['claude', '--model', 'x'],
        });
        expect(launchParameters(['--', '/usr/local/bin/codex'])).toMatchObject({
            provider: 'codex',
        });
        expect(() => launchParameters(['--', 'claude-wrapper'])).toThrow(/--provider/u);
        expect(() => launchParameters(['--', 'node'])).toThrow(/--provider/u);
        expect(launchParameters(['--provider', 'grok', '--', 'node'])).toMatchObject({
            provider: 'grok',
        });
    });

    it('rejects an unknown provider, a missing command, repeated or unknown options', () => {
        expect(() => launchParameters(['--provider', 'gemini', '--', 'x'])).toThrow();
        expect(() => launchParameters(['--provider', 'claude'])).toThrow(/--/u);
        expect(() => launchParameters(['--root', '/a', '--root', '/b', '--', 'claude'])).toThrow();
        expect(() => launchParameters(['--bogus', 'x', '--', 'claude'])).toThrow();
        expect(() => launchParameters(['--ttl-ms', 'soon', '--', 'claude'])).toThrow(/integer/u);
    });
});

describe('agent delegate access launch', () => {
    it('is owner-only and never connects for an Agent-recognized invocation', async () => {
        const { connect, io } = launcher();
        expect(
            await runCli([...base, '--', 'claude'], {
                connect,
                environment: { CODEX_THREAD_ID: 'x' },
                io,
            }),
        ).toBe(5);
        expect(connect).not.toHaveBeenCalled();
    });

    it('passes the credential to the child, never prints it, and revokes the exact generation', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'launch-'));
        const output = join(directory, 'env.json');
        const script = `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.env))`;
        const { calls, connect, events, io, stderr, stdout } = launcher();
        const code = await runCli(
            [
                ...base,
                '--root',
                directory,
                '--provider',
                'codex',
                '--ttl-ms',
                '60000',
                '--',
                process.execPath,
                '-e',
                script,
            ],
            {
                connect,
                cwd: directory,
                environment: {
                    CAXRI_DELEGATION_PROJECT_ID: 'stale',
                    PATH: process.env.PATH,
                },
                io,
            },
        );
        expect(code).toBe(0);
        const child = JSON.parse(readFileSync(output, 'utf8')) as Record<string, string>;
        expect(child).toMatchObject({
            CAXRI_USER_DATA_DIR: '/profiles/owner',
            CAXRI_DELEGATION_CLIENT_ID: grant.clientId,
            CAXRI_DELEGATION_GENERATION: '3',
            CAXRI_DELEGATION_TOKEN: grant.token,
            CAXRI_DELEGATION_PROJECT_ID: 'project-1',
            CAXRI_DELEGATION_SESSION_ID: 'session-1',
        });
        expect(stdout() + stderr()).not.toContain(grant.token);
        expect(calls[0]).toEqual({
            method: 'agent.delegation.access.create',
            parameters: {
                rootPath: realpathSync(directory),
                callerProvider: 'codex',
                registerProject: true,
                ttlMs: 60_000,
            },
        });
        expect(calls.at(-1)).toEqual({
            method: 'agent.delegation.access.revoke',
            parameters: { clientId: grant.clientId, generation: 3 },
        });
        expect(events.indexOf('agent.delegation.access.revoke')).toBeLessThan(
            events.indexOf('close'),
        );
    });

    it('defaults the root to the top-level Project containing the working directory', async () => {
        const directory = canonicalTemporary('launch-root-');
        const nested = join(directory, 'packages', 'app');
        const { calls, connect, io } = launcher([
            { id: 'worktree', rootPath: nested, ownerProjectId: 'top' },
            { id: 'top', rootPath: directory },
        ]);
        await runCli([...base, '--provider', 'codex', '--', process.execPath, '-e', ''], {
            connect,
            cwd: nested,
            environment: {},
            io,
        });
        expect(calls[1]).toMatchObject({
            method: 'agent.delegation.access.create',
            parameters: { rootPath: directory },
        });
    });

    it('falls back to the working directory outside every Project', async () => {
        const directory = canonicalTemporary('launch-cwd-');
        const { calls, connect, io } = launcher([{ id: 'other', rootPath: '/elsewhere' }]);
        await runCli([...base, '--provider', 'codex', '--', process.execPath, '-e', ''], {
            connect,
            cwd: directory,
            environment: {},
            io,
        });
        expect(calls[1]).toMatchObject({ parameters: { rootPath: directory } });
    });

    it('revokes and reports the Agent exit code on a non-zero exit', async () => {
        const { calls, connect, io } = launcher();
        const code = await runCli(
            [
                ...base,
                '--root',
                tmpdir(),
                '--provider',
                'codex',
                '--',
                process.execPath,
                '-e',
                'process.exit(7)',
            ],
            { connect, environment: {}, io },
        );
        expect(code).toBe(7);
        expect(calls.at(-1)?.method).toBe('agent.delegation.access.revoke');
    });

    it('revokes after the Agent dies from a signal and reports 128 + signal', async () => {
        const { calls, connect, io } = launcher();
        const code = await runCli(
            [
                ...base,
                '--root',
                tmpdir(),
                '--provider',
                'codex',
                '--',
                process.execPath,
                '-e',
                "process.kill(process.pid, 'SIGTERM')",
            ],
            { connect, environment: {}, io },
        );
        expect(code).toBe(143);
        expect(calls.at(-1)?.method).toBe('agent.delegation.access.revoke');
    });

    it('revokes when the Agent cannot be started', async () => {
        const { calls, connect, io, stderr } = launcher();
        const code = await runCli(
            [...base, '--root', tmpdir(), '--provider', 'codex', '--', '/no/such/agent-binary'],
            { connect, environment: {}, io },
        );
        expect(code).not.toBe(0);
        expect(stderr()).toContain('Command not found');
        expect(calls.at(-1)?.method).toBe('agent.delegation.access.revoke');
    });

    it('revokes before closing the owner connection when the CLI is interrupted', async () => {
        const controller = new AbortController();
        const { calls, connect, events, io } = launcher();
        const running = runCli(
            [
                ...base,
                '--root',
                tmpdir(),
                '--provider',
                'codex',
                '--',
                process.execPath,
                '-e',
                'setTimeout(() => {}, 400)',
            ],
            { connect, environment: {}, io, signal: controller.signal },
        );
        await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
        controller.abort();
        await running;
        expect(calls.at(-1)?.method).toBe('agent.delegation.access.revoke');
        expect(events.indexOf('agent.delegation.access.revoke')).toBeLessThan(
            events.indexOf('close'),
        );
    });

    it('does not start the Agent when interrupted before the credential arrives', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'launch-abort-'));
        const marker = join(directory, 'started');
        const controller = new AbortController();
        const { calls, client, connect, io } = launcher();
        client.request = vi.fn((method: CaxriMethod, parameters: unknown) => {
            calls.push({ method, parameters });
            if (method === 'agent.delegation.access.create') controller.abort();
            return Promise.resolve(grant);
        });
        const code = await runCli(
            [
                ...base,
                '--root',
                directory,
                '--provider',
                'codex',
                '--',
                process.execPath,
                '-e',
                `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '1')`,
            ],
            { connect, environment: {}, io, signal: controller.signal },
        );
        expect(code).toBe(130);
        expect(() => readFileSync(marker)).toThrow();
        expect(calls.at(-1)?.method).toBe('agent.delegation.access.revoke');
    });

    it('tells the user how to revoke when revocation fails, without the token', async () => {
        const { connect, io, request, stderr } = launcher();
        request.mockImplementation((method: CaxriMethod) =>
            method === 'agent.delegation.access.revoke'
                ? Promise.reject(new Error('socket closed'))
                : Promise.resolve(grant),
        );
        await runCli(
            [...base, '--root', tmpdir(), '--provider', 'codex', '--', process.execPath, '-e', ''],
            { connect, environment: {}, io },
        );
        expect(stderr()).toContain(`--client ${grant.clientId} --generation 3`);
        expect(stderr()).not.toContain(grant.token);
    });

    it('keeps SIGINT, SIGTERM and SIGHUP handled until the revoke request settled', async () => {
        const { connect, io, request } = launcher();
        const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
        const before = signals.map((signal) => process.listenerCount(signal));
        let during: number[] = [];
        request.mockImplementation((method: CaxriMethod) => {
            if (method !== 'agent.delegation.access.revoke') return Promise.resolve(grant);
            // The Agent already exited here: a signal now must not take the default action.
            during = signals.map((signal) => process.listenerCount(signal));
            return Promise.resolve({});
        });
        await runCli(
            [...base, '--root', tmpdir(), '--provider', 'codex', '--', process.execPath, '-e', ''],
            { connect, environment: {}, io },
        );
        expect(during.map((count, index) => count - (before[index] ?? 0))).toEqual([1, 1, 1]);
        expect(signals.map((signal) => process.listenerCount(signal))).toEqual(before);
    });
});
