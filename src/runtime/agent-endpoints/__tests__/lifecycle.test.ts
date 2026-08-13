import { describe, expect, it, vi } from 'vitest';

import type {
    AgentEndpointBeginParams,
    AgentEndpointMessagingParams,
    AgentEndpointRetireParams,
} from '../../../shared/ipc/agent-endpoint-control';
import type { TerminalRecord } from '../../../shared/types';
import { AgentMessagingCapabilityProbe } from '../../agent-messaging';
import { classifyAgentPermission, RuntimeAgentEndpointLifecycle } from '../lifecycle';

function terminal(kind: 'codex' | 'shell' = 'codex'): TerminalRecord {
    return {
        id: 'terminal-1',
        sessionId: 'session-1',
        kind,
        ...(kind === 'shell' ? {} : { provider: kind }),
        cwd: '/project',
        title: kind === 'shell' ? 'Shell' : 'Codex',
        icon: 'terminal',
        orderIndex: 0,
        layoutNodeId: 'layout-1',
        lastProcessState: 'starting',
        createdAt: 1,
        updatedAt: 1,
    };
}

describe('RuntimeAgentEndpointLifecycle', () => {
    const probe = () =>
        new AgentMessagingCapabilityProbe({
            cliAvailable: () => Promise.resolve(true),
            cliPath: '/caxri',
            fixtureMode: true,
            now: () => 1,
            probe: () => Promise.resolve({ executable: '/bin/codex', version: 'fixture 1.0.0' }),
        });

    it('injects a Host-issued credential only for a direct Agent generation', async () => {
        const begin = vi.fn((params: AgentEndpointBeginParams) => {
            void params;
            return Promise.resolve({
                ref: { hostId: 'host-1', endpointId: 'endpoint-1', generation: 1 },
                token: 'ab'.repeat(32),
                expiresAt: 10_000,
            });
        });
        const retire = vi.fn((params: AgentEndpointRetireParams) => {
            void params;
            return Promise.resolve(true);
        });
        const messaging = vi.fn((params: AgentEndpointMessagingParams) => {
            void params;
            return Promise.resolve(true);
        });
        const lifecycle = new RuntimeAgentEndpointLifecycle(
            { begin, messaging, retire },
            '/profile',
            probe(),
        );

        await expect(
            lifecycle.environment(terminal(), 'project-1', {
                hooks: { enabled: false },
                launch: { executable: 'codex', args: [] },
                messaging: { enabled: true },
            }),
        ).resolves.toMatchObject({
            CAXRI_AGENT_ENDPOINT_HOST_ID: 'host-1',
            CAXRI_AGENT_ENDPOINT_ID: 'endpoint-1',
            CAXRI_AGENT_ENDPOINT_GENERATION: '1',
            CAXRI_AGENT_ENDPOINT_TOKEN: 'ab'.repeat(32),
            CAXRI_USER_DATA_DIR: '/profile',
        });
        expect(begin).toHaveBeenCalledWith(
            expect.objectContaining({
                terminalId: 'terminal-1',
                projectId: 'project-1',
                provider: 'codex',
                permissionClass: 'standard',
            }),
        );
        expect(begin.mock.calls[0]?.[0].messaging).toMatchObject({
            deliveryMode: 'pull',
            reason: 'fixture_pull_ready',
        });
        await expect(
            lifecycle.environment(terminal('shell'), 'project-1', {
                hooks: { enabled: false },
                launch: { executable: '/bin/zsh', args: [] },
                messaging: { enabled: true },
            }),
        ).resolves.toEqual({});
        expect(begin).toHaveBeenCalledTimes(1);
    });

    it('retires the exact prior launch before reusing a durable Terminal ID', async () => {
        let generation = 0;
        const retire = vi.fn((params: AgentEndpointRetireParams) => {
            void params;
            return Promise.resolve(true);
        });
        const lifecycle = new RuntimeAgentEndpointLifecycle(
            {
                begin: vi.fn((params: AgentEndpointBeginParams) => {
                    void params;
                    generation += 1;
                    return Promise.resolve({
                        ref: {
                            hostId: 'host-1',
                            endpointId: `endpoint-${generation}`,
                            generation,
                        },
                        token: 'ab'.repeat(32),
                        expiresAt: 10_000,
                    });
                }),
                messaging: vi.fn(() => Promise.resolve(true)),
                retire,
            },
            '/profile',
            probe(),
        );
        const settings = {
            hooks: { enabled: false },
            launch: { executable: 'codex', args: [] },
            messaging: { enabled: true },
        };
        await lifecycle.environment(terminal(), 'project-1', settings);
        await lifecycle.environment(terminal(), 'project-1', settings);

        expect(retire).toHaveBeenCalledTimes(1);
        expect(retire).toHaveBeenCalledWith(
            expect.objectContaining({
                ref: { hostId: 'host-1', endpointId: 'endpoint-1', generation: 1 },
            }),
        );
        expect(typeof retire.mock.calls[0]?.[0].launchId).toBe('string');
    });

    it('downgrades messaging authority without retiring the running Terminal generation', async () => {
        const begin = vi.fn(() =>
            Promise.resolve({
                ref: { hostId: 'host-1', endpointId: 'endpoint-1', generation: 1 },
                token: 'ab'.repeat(32),
                expiresAt: 10_000,
            }),
        );
        const messaging = vi.fn((params: AgentEndpointMessagingParams) => {
            void params;
            return Promise.resolve(true);
        });
        const retire = vi.fn(() => Promise.resolve(true));
        const lifecycle = new RuntimeAgentEndpointLifecycle(
            { begin, messaging, retire },
            '/profile',
            probe(),
        );
        const enabled = {
            codex: {
                hooks: { enabled: false },
                launch: { executable: 'codex', args: [] },
                messaging: { enabled: true },
            },
            claude: {
                hooks: { enabled: false },
                launch: { executable: 'claude', args: [] },
                messaging: { enabled: true },
            },
        };
        await lifecycle.environment(terminal(), 'project-1', enabled.codex);
        await lifecycle.reconcile({
            ...enabled,
            codex: { ...enabled.codex, messaging: { enabled: false } },
        });

        expect(messaging).toHaveBeenCalledWith(
            expect.objectContaining({
                ref: { hostId: 'host-1', endpointId: 'endpoint-1', generation: 1 },
            }),
        );
        expect(messaging.mock.calls[0]?.[0].messaging).toMatchObject({
            deliveryMode: 'unavailable',
            reason: 'integration_disabled',
        });
        expect(retire).not.toHaveBeenCalled();
    });

    it('classifies only explicit provider evidence and fails custom launches closed', () => {
        expect(classifyAgentPermission('codex', { executable: 'codex', args: [] })).toBe(
            'standard',
        );
        expect(
            classifyAgentPermission('codex', {
                executable: 'codex',
                args: ['--dangerously-bypass-approvals-and-sandbox'],
            }),
        ).toBe('elevated');
        expect(classifyAgentPermission('claude', { executable: '/custom/claude', args: [] })).toBe(
            'unknown',
        );
        expect(
            classifyAgentPermission('claude', {
                executable: '/custom/claude',
                args: ['--dangerously-skip-permissions'],
            }),
        ).toBe('unknown');
    });
});
