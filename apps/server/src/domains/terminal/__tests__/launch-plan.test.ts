import process from 'node:process';

import type { TerminalRecord } from '@caxri/protocol';
import { defaultAgentProviderSettings } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import { describe, expect, it, vi } from 'vitest';

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

describe('TerminalLaunchPlanner managed Agent launch', () => {
    it('keeps the long-lived Shell free of Agent credentials and launches the Agent as its child', async () => {
        const shellIntegration = vi.fn((_executable: string, environment: NodeJS.ProcessEnv) => ({
            args: ['--caxri-shell'],
            environment: { ...environment, CAXRI_SHELL_INTEGRATED: '1' },
        }));
        const planner = new TerminalLaunchPlanner({
            agentEnvironment: () => Promise.resolve({ HOME: '/tmp', PATH: '/agent/bin' }),
            agentLaunchSettings: () => ({ executable: 'codex', args: ['--profile', 'focused'] }),
            lifecycleEnvironment: () => ({
                CAXRI_AGENT_ENDPOINT_TOKEN: 'agent-secret',
                CAXRI_MANAGED_AGENT: '1',
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
            environment: { CAXRI_SHELL_INTEGRATED: '1' },
            agent: {
                provider: 'codex',
                executable: '/usr/local/bin/codex',
                args: ['--profile', 'focused', 'resume', 'conversation-1'],
                environment: {
                    CAXRI_MANAGED_AGENT: '1',
                    CAXRI_AGENT_ENDPOINT_TOKEN: 'agent-secret',
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
        expect(resolved.value.agent?.args).toEqual(defaultAgentProviderSettings.codex.launch.args);
        const prepared = await planner.prepare(record, resolved.value);
        if (!prepared.ok) throw prepared.error;

        expect(prepared.value.executable).toBe('/bin/zsh');
        expect(shellIntegration).toHaveBeenCalledWith('/bin/zsh', expect.any(Object));
    });
});
