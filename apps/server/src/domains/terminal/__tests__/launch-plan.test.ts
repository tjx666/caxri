import process from 'node:process';

import type { TerminalRecord } from '@caxri/protocol';
import { CaxriError, defaultAgentProviderSettings } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import { describe, expect, it, vi } from 'vitest';

import { resolveTerminalExecutable } from '../launch';
import { TerminalLaunchPlanner } from '../launch-plan';

const record: TerminalRecord = {
    id: 'terminal-1',
    sessionId: 'session-1',
    kind: 'codex',
    provider: 'codex',
    title: 'Codex',
    icon: 'terminal',
    orderIndex: 0,
    cwd: process.cwd(),
    createdAt: 1,
    updatedAt: 1,
    lastProcessState: 'starting',
    lastAgentProcessState: 'starting',
};

describe('default shell resolution', () => {
    it('falls back to the system shell when SHELL names an uninstalled shell', async () => {
        vi.stubEnv('SHELL', '/nonexistent/caxri-test/fish');
        try {
            await expect(resolveTerminalExecutable('shell', undefined, undefined)).resolves.toBe(
                '/bin/zsh',
            );
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('names a missing shell instead of reporting a generic spawn failure', async () => {
        const planner = new TerminalLaunchPlanner({
            logger: new StructuredLogger('/tmp/caxri-launch-plan-test-logs'),
            resolveExecutable: () =>
                Promise.reject(
                    new CaxriError('UNAVAILABLE', 'Shell /bin/zsh was not found', {
                        reason: 'shell_not_found',
                    }),
                ),
        });

        await expect(
            planner.resolve({ ...record, kind: 'shell', provider: undefined }),
        ).resolves.toMatchObject({
            ok: false,
            failureReason: 'executable_not_found',
            failureDetail: 'Shell /bin/zsh was not found',
        });
    });
});

describe('TerminalLaunchPlanner managed Agent launch', () => {
    it('keeps the missing provider name when executable resolution fails', async () => {
        const planner = new TerminalLaunchPlanner({
            logger: new StructuredLogger('/tmp/caxri-launch-plan-test-logs'),
            resolveExecutable: (kind) =>
                kind === 'shell'
                    ? Promise.resolve('/bin/zsh')
                    : Promise.reject(new Error('private executable path')),
        });

        const resolved = await planner.resolve({ ...record, kind: 'claude', provider: 'claude' });
        expect(resolved).toMatchObject({
            ok: false,
            failureReason: 'executable_not_found',
            failureDetail: 'Claude CLI was not found',
        });
    });

    it('keeps the specific shell-integration failure for managed Agent recovery', async () => {
        const planner = new TerminalLaunchPlanner({
            logger: new StructuredLogger('/tmp/caxri-launch-plan-test-logs'),
            resolveExecutable: (kind) =>
                Promise.resolve(kind === 'shell' ? '/bin/zsh' : '/bin/codex'),
            shellIntegration: () => {},
        });

        const resolved = await planner.resolve(record);
        if (!resolved.ok) throw resolved.error;
        const prepared = await planner.prepare(record, resolved.value);
        expect(prepared).toMatchObject({
            ok: false,
            failureReason: 'spawn_failed',
            failureDetail: 'Managed Agent Terminals require zsh or bash shell integration.',
        });
    });

    it.each([undefined, 'conversation-1'])(
        'isolates Codex with custom settings when resuming %s',
        async (resumeAgentSessionId) => {
            const launch = { executable: 'codex', args: ['--profile', 'focused'] };
            const planner = new TerminalLaunchPlanner({
                logger: new StructuredLogger('/tmp/caxri-launch-plan-test-logs'),
                resolveExecutable: (kind) =>
                    Promise.resolve(kind === 'shell' ? '/bin/zsh' : '/usr/local/bin/codex'),
            });
            const resolved = await planner.resolve(record, {
                launchSettings: launch,
                resumeAgentSessionId,
                initialPrompt: 'fixture prompt',
            });
            if (!resolved.ok) throw resolved.error;
            expect(resolved.value.agent?.args).toEqual([
                '-c',
                'tui.auto_recap=false',
                '--profile',
                'focused',
                ...(resumeAgentSessionId ? ['resume', resumeAgentSessionId] : []),
                '--',
                'fixture prompt',
            ]);
            expect(launch.args).toEqual(['--profile', 'focused']);
        },
    );

    it('adds Server-owned arguments after the provider arguments and before settings and resume', async () => {
        const planner = new TerminalLaunchPlanner({
            agentLaunchArguments: (terminal) =>
                terminal.id === record.id ? ['-c', 'server.owned=true'] : [],
            logger: new StructuredLogger('/tmp/caxri-launch-plan-test-logs'),
            resolveExecutable: (kind) =>
                Promise.resolve(kind === 'shell' ? '/bin/zsh' : '/usr/local/bin/codex'),
        });
        const resolved = await planner.resolve(record, {
            launchSettings: { executable: 'codex', args: ['--profile', 'focused'] },
            resumeAgentSessionId: 'conversation-1',
        });
        if (!resolved.ok) throw resolved.error;
        expect(resolved.value.agent?.args).toEqual([
            '-c',
            'tui.auto_recap=false',
            '-c',
            'server.owned=true',
            '--profile',
            'focused',
            'resume',
            'conversation-1',
        ]);
    });

    it('splits a flag and value saved on one line', async () => {
        const launch = { executable: 'codex', args: ['--profile focused'] };
        const planner = new TerminalLaunchPlanner({
            logger: new StructuredLogger('/tmp/caxri-launch-plan-test-logs'),
            resolveExecutable: (kind) =>
                Promise.resolve(kind === 'shell' ? '/bin/zsh' : '/usr/local/bin/codex'),
        });
        const resolved = await planner.resolve(record, { launchSettings: launch });
        if (!resolved.ok) throw resolved.error;
        expect(resolved.value.agent?.args).toEqual([
            '-c',
            'tui.auto_recap=false',
            '--profile',
            'focused',
        ]);
    });
    it('keeps the long-lived Shell free of Agent credentials and launches the Agent as its child', async () => {
        const shellIntegration = vi.fn((_executable: string, environment: NodeJS.ProcessEnv) => ({
            args: ['--caxri-shell'],
            environment: { ...environment, CAXRI_SHELL_INTEGRATED: '1' },
        }));
        const planner = new TerminalLaunchPlanner({
            shellEnvironment: () => ({
                CAXRI_HOOK_TOKEN: 'shell-observer',
                CAXRI_HOOK_LAUNCH_ID: 'shell-generation',
            }),
            agentEnvironment: () => Promise.resolve({ HOME: '/tmp', PATH: '/agent/bin' }),
            agentLaunchSettings: () => ({ executable: 'codex', args: ['--profile', 'focused'] }),
            lifecycleEnvironment: () => ({
                CAXRI_AGENT_ENDPOINT_TOKEN: 'agent-secret',
                CAXRI_MANAGED_AGENT: '1',
                CAXRI_HOOK_TOKEN: 'managed-observer',
            }),
            logger: new StructuredLogger('/tmp/caxri-launch-plan-test-logs'),
            resolveExecutable: (kind) =>
                Promise.resolve(kind === 'shell' ? '/bin/zsh' : '/usr/local/bin/codex'),
            shellIntegration,
        });

        const resolved = await planner.resolve(record, { resumeAgentSessionId: 'conversation-1' });
        expect(resolved.ok).toBe(true);
        if (!resolved.ok) return;
        const prepared = await planner.prepare(record, resolved.value);
        if (!prepared.ok) throw prepared.error;

        expect(prepared.value).toMatchObject({
            executable: '/bin/zsh',
            args: ['--caxri-shell'],
            environment: {
                CAXRI_SHELL_INTEGRATED: '1',
                CAXRI_HOOK_TOKEN: 'shell-observer',
                CAXRI_HOOK_LAUNCH_ID: 'shell-generation',
            },
            agent: {
                provider: 'codex',
                executable: '/usr/local/bin/codex',
                args: [
                    '-c',
                    'tui.auto_recap=false',
                    '--profile',
                    'focused',
                    'resume',
                    'conversation-1',
                ],
                environment: {
                    CAXRI_MANAGED_AGENT: '1',
                    CAXRI_AGENT_ENDPOINT_TOKEN: 'agent-secret',
                    CAXRI_HOOK_TOKEN: 'managed-observer',
                    COLORTERM: 'truecolor',
                    HOME: '/tmp',
                    PATH: '/agent/bin',
                    TERM: 'xterm-256color',
                },
            },
        });
        expect(prepared.value.environment).not.toHaveProperty('CAXRI_AGENT_ENDPOINT_TOKEN');
        expect(prepared.value.environment).not.toHaveProperty('CAXRI_MANAGED_AGENT');
        expect(shellIntegration).toHaveBeenCalledWith('/bin/zsh', expect.any(Object));
    });

    it('prepares observation for an ordinary Shell without preparing managed Agent authority', async () => {
        const lifecycleEnvironment = vi.fn();
        const planner = new TerminalLaunchPlanner({
            shellEnvironment: () => ({ CAXRI_HOOK_TOKEN: 'shell-observer' }),
            lifecycleEnvironment,
            logger: new StructuredLogger('/tmp/caxri-launch-plan-test-logs'),
            resolveExecutable: () => Promise.resolve('/bin/zsh'),
        });
        const shell = { ...record, kind: 'shell' as const, provider: undefined };
        const resolved = await planner.resolve(shell);
        if (!resolved.ok) throw resolved.error;
        const prepared = await planner.prepare(shell, resolved.value);
        if (!prepared.ok) throw prepared.error;
        expect(prepared.value.environment).toHaveProperty('CAXRI_HOOK_TOKEN', 'shell-observer');
        expect(prepared.value.agent).toBeUndefined();
        expect(lifecycleEnvironment).not.toHaveBeenCalled();
    });

    it('falls back to the system zsh when the configured Shell cannot host a managed Agent', async () => {
        const shellIntegration = vi.fn((_executable: string, environment: NodeJS.ProcessEnv) => ({
            args: ['--managed-agent-shell'],
            environment,
        }));
        const planner = new TerminalLaunchPlanner({
            logger: new StructuredLogger('/tmp/caxri-launch-plan-test-logs'),
            resolveExecutable: (kind) =>
                Promise.resolve(kind === 'shell' ? '/bin/sh' : '/usr/local/bin/codex'),
            shellIntegration,
        });

        const resolved = await planner.resolve(record);
        if (!resolved.ok) throw resolved.error;
        expect(resolved.value.agent?.args).toEqual([
            '-c',
            'tui.auto_recap=false',
            ...defaultAgentProviderSettings.codex.launch.args,
        ]);
        const prepared = await planner.prepare(record, resolved.value);
        if (!prepared.ok) throw prepared.error;

        expect(prepared.value.executable).toBe('/bin/zsh');
        expect(shellIntegration).toHaveBeenCalledWith('/bin/zsh', expect.any(Object));
    });
});
