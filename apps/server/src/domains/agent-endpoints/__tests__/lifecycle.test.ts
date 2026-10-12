import type {
    AgentEndpointActivateParams as AgentEndpointActivateParameters,
    AgentEndpointBeginParams as AgentEndpointBeginParameters,
    AgentEndpointBeginResult,
    AgentEndpointMessagingParams as AgentEndpointMessagingParameters,
    AgentEndpointRetireParams as AgentEndpointRetireParameters,
    TerminalRecord,
} from '@caxri/protocol';
import {
    defaultAgentActionsSettings,
    defaultAgentOutputRecoverySettings,
    defaultAgentProviderSettings,
} from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentMessagingCapabilityProbe } from '../../agent-messaging';
import { AgentEndpointLifecycle, classifyAgentPermission } from '../lifecycle';

function terminal(
    kind: 'codex' | 'shell' = 'codex',
    id = 'terminal-1',
    metadata: Partial<Pick<TerminalRecord, 'agentSessionId' | 'title'>> = {},
): TerminalRecord {
    return {
        id,
        sessionId: 'session-1',
        kind,
        ...(kind !== 'shell' && { provider: kind }),
        cwd: '/project',
        title: kind === 'shell' ? 'Shell' : 'Codex',
        ptyTitle: 'dynamic PTY title',
        icon: 'terminal',
        orderIndex: 0,
        lastProcessState: 'starting',
        createdAt: 1,
        updatedAt: 1,
        ...metadata,
    };
}

describe('AgentEndpointLifecycle', () => {
    const probe = () =>
        new AgentMessagingCapabilityProbe({
            cliAvailable: () => Promise.resolve(true),
            cliPath: '/caxri',
            fixtureMode: true,
            now: () => 1,
            probe: () => Promise.resolve({ executable: '/bin/codex', version: 'fixture 1.0.0' }),
        });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('injects a Host-issued credential only for a direct Agent generation', async () => {
        vi.stubEnv('CAXRI_CLI', '/profile/bin/caxri');
        const begin = vi.fn<
            (parameters: AgentEndpointBeginParameters) => Promise<AgentEndpointBeginResult>
        >(() => {
            return Promise.resolve({
                ref: { hostId: 'host-1', endpointId: 'endpoint-1', generation: 1 },
                token: 'ab'.repeat(32),
                expiresAt: 10_000,
            });
        });
        const retire = vi.fn<(parameters: AgentEndpointRetireParameters) => Promise<boolean>>(
            () => {
                return Promise.resolve(true);
            },
        );
        let activationInput: AgentEndpointActivateParameters | undefined;
        const activate = vi.fn((parameters: AgentEndpointActivateParameters) => {
            activationInput = parameters;
            return Promise.resolve(true);
        });
        const messaging = vi.fn(() => {
            return Promise.resolve(true);
        });
        const lifecycle = new AgentEndpointLifecycle(
            { activate, begin, messaging, retire },
            '/profile',
            probe(),
        );

        await expect(
            lifecycle.environment(terminal(), 'project-1', {
                actions: structuredClone(defaultAgentActionsSettings),
                hooks: { enabled: false },
                launch: { executable: 'codex', args: [] },
                messaging: { enabled: true },
                recovery: defaultAgentOutputRecoverySettings,
            }),
        ).resolves.toMatchObject({
            CAXRI_MANAGED_AGENT: '1',
            CAXRI_AGENT_ENDPOINT_HOST_ID: 'host-1',
            CAXRI_AGENT_ENDPOINT_ID: 'endpoint-1',
            CAXRI_AGENT_ENDPOINT_GENERATION: '1',
            CAXRI_AGENT_ENDPOINT_TOKEN: 'ab'.repeat(32),
            CAXRI_CLI: '/profile/bin/caxri',
            CAXRI_USER_DATA_DIR: '/profile',
        });
        expect(begin).toHaveBeenCalledWith(
            expect.objectContaining({
                terminalId: 'terminal-1',
                projectId: 'project-1',
                provider: 'codex',
                name: 'Codex',
                permissionClass: 'standard',
            }),
        );
        expect(begin.mock.calls[0]?.[0].messaging).toMatchObject({
            deliveryMode: 'unavailable',
            reason: 'probe_pending',
        });
        expect(lifecycle.preparedEndpointForTerminal('terminal-1')).toMatchObject({
            ref: { hostId: 'host-1', endpointId: 'endpoint-1', generation: 1 },
            terminalId: 'terminal-1',
        });
        expect(lifecycle.endpointForTerminal('terminal-1')).toBeUndefined();
        expect(messaging).not.toHaveBeenCalled();
        await lifecycle.activate('terminal-1');
        expect(activationInput).toMatchObject({
            ref: { hostId: 'host-1', endpointId: 'endpoint-1', generation: 1 },
        });
        expect(typeof activationInput?.launchId).toBe('string');
        await vi.waitFor(() => expect(messaging).toHaveBeenCalledOnce());
        await expect(
            lifecycle.environment(terminal('shell'), 'project-1', {
                actions: structuredClone(defaultAgentActionsSettings),
                hooks: { enabled: false },
                launch: { executable: '/bin/zsh', args: [] },
                messaging: { enabled: true },
                recovery: defaultAgentOutputRecoverySettings,
            }),
        ).resolves.toEqual({});
        expect(begin).toHaveBeenCalledTimes(1);
    });

    it('uses the provider name before metadata and the conversation title on restart', async () => {
        const begin = vi.fn<
            (parameters: AgentEndpointBeginParameters) => Promise<AgentEndpointBeginResult>
        >((parameters) =>
            Promise.resolve({
                ref: {
                    hostId: 'host-1',
                    endpointId: `${parameters.terminalId}-endpoint`,
                    generation: 1,
                },
                token: 'ab'.repeat(32),
                expiresAt: 10_000,
            }),
        );
        const retire = vi.fn(() => Promise.resolve(true));
        const lifecycle = new AgentEndpointLifecycle(
            {
                activate: vi.fn(() => Promise.resolve(true)),
                begin,
                messaging: vi.fn(() => Promise.resolve(true)),
                retire,
            },
            '/profile',
            probe(),
        );
        const settings = structuredClone(defaultAgentProviderSettings.codex);

        await lifecycle.environment(
            terminal('codex', 'terminal-1', { title: 'Stale conversation title' }),
            'project-1',
            settings,
        );
        await lifecycle.environment(
            terminal('codex', 'terminal-1', {
                agentSessionId: 'codex-session-1',
                title: 'Ship the release notes',
            }),
            'project-1',
            settings,
        );

        expect(begin.mock.calls.map(([parameters]) => parameters.name)).toEqual([
            'Codex',
            'Ship the release notes',
        ]);
        expect(retire).toHaveBeenCalledOnce();
    });

    it('retires the exact prior launch before reusing a durable Terminal ID', async () => {
        let generation = 0;
        const retire = vi.fn<(parameters: AgentEndpointRetireParameters) => Promise<boolean>>(
            () => {
                return Promise.resolve(true);
            },
        );
        const lifecycle = new AgentEndpointLifecycle(
            {
                activate: vi.fn(() => Promise.resolve(true)),
                begin: vi.fn(() => {
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
            actions: structuredClone(defaultAgentActionsSettings),
            hooks: { enabled: false },
            launch: { executable: 'codex', args: [] },
            messaging: { enabled: true },
            recovery: defaultAgentOutputRecoverySettings,
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

    it('synchronously fences a live Endpoint while Host retirement is delayed', async () => {
        const retirement = Promise.withResolvers<boolean>();
        const activate = vi.fn(() => Promise.resolve(true));
        const lifecycle = new AgentEndpointLifecycle(
            {
                activate,
                begin: vi.fn(() =>
                    Promise.resolve({
                        ref: { hostId: 'host-1', endpointId: 'endpoint-1', generation: 1 },
                        token: 'ab'.repeat(32),
                        expiresAt: 10_000,
                    }),
                ),
                messaging: vi.fn(() => Promise.resolve(true)),
                retire: vi.fn(() => retirement.promise),
            },
            '/profile',
            probe(),
        );
        const settings = {
            actions: structuredClone(defaultAgentActionsSettings),
            hooks: { enabled: false },
            launch: { executable: 'codex', args: [] },
            messaging: { enabled: true },
            recovery: defaultAgentOutputRecoverySettings,
        };

        await lifecycle.environment(terminal(), 'project-1', settings);
        await lifecycle.activate('terminal-1');
        const target = lifecycle.endpointForTerminal('terminal-1');
        expect(target).toBeDefined();

        const retiring = lifecycle.retire('terminal-1');
        await vi.waitFor(() => expect(lifecycle.endpointForTerminal('terminal-1')).toBeUndefined());
        expect(lifecycle.preparedEndpointForTerminal('terminal-1')).toBeUndefined();
        expect(() => lifecycle.controlTarget(target!.ref)).toThrow(
            expect.objectContaining({ code: 'UNAVAILABLE' }) as Error,
        );
        expect(lifecycle.isCurrent(target!)).toBe(false);
        await expect(lifecycle.activate('terminal-1')).rejects.toThrow(
            'unavailable after PTY launch',
        );
        expect(activate).toHaveBeenCalledOnce();

        retirement.resolve(true);
        await expect(retiring).resolves.toBeUndefined();
    });

    it('downgrades messaging authority without retiring the running Terminal generation', async () => {
        const begin = vi.fn(() =>
            Promise.resolve({
                ref: { hostId: 'host-1', endpointId: 'endpoint-1', generation: 1 },
                token: 'ab'.repeat(32),
                expiresAt: 10_000,
            }),
        );
        const messaging = vi.fn<(parameters: AgentEndpointMessagingParameters) => Promise<boolean>>(
            () => {
                return Promise.resolve(true);
            },
        );
        const retire = vi.fn(() => Promise.resolve(true));
        const lifecycle = new AgentEndpointLifecycle(
            { activate: vi.fn(() => Promise.resolve(true)), begin, messaging, retire },
            '/profile',
            probe(),
        );
        const enabled = structuredClone(defaultAgentProviderSettings);
        await lifecycle.environment(terminal(), 'project-1', enabled.codex);
        await lifecycle.activate('terminal-1');
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

    it('reconciles identical live Endpoint launches through one capability probe', async () => {
        const providerProbe = vi.fn(() =>
            Promise.resolve({ executable: '/bin/codex', version: 'codex-cli 0.147.0' }),
        );
        const capabilityProbe = new AgentMessagingCapabilityProbe({
            cliAvailable: () => Promise.resolve(true),
            cliPath: '/caxri',
            fixtureMode: false,
            probe: providerProbe,
        });
        let generation = 0;
        const lifecycle = new AgentEndpointLifecycle(
            {
                activate: vi.fn(() => Promise.resolve(true)),
                begin: vi.fn((parameters: AgentEndpointBeginParameters) => {
                    generation += 1;
                    return Promise.resolve({
                        ref: {
                            hostId: 'host-1',
                            endpointId: `${parameters.terminalId}-endpoint`,
                            generation,
                        },
                        token: 'ab'.repeat(32),
                        expiresAt: 10_000,
                    });
                }),
                messaging: vi.fn(() => Promise.resolve(true)),
                retire: vi.fn(() => Promise.resolve(true)),
            },
            '/profile',
            capabilityProbe,
        );
        const settings = structuredClone(defaultAgentProviderSettings);

        await lifecycle.environment(terminal('codex', 'terminal-1'), 'project-1', settings.codex);
        await lifecycle.environment(terminal('codex', 'terminal-2'), 'project-1', settings.codex);
        await lifecycle.activate('terminal-1');
        await lifecycle.activate('terminal-2');
        await vi.waitFor(() => expect(providerProbe).toHaveBeenCalledOnce());
        providerProbe.mockClear();

        await lifecycle.reconcile(settings);

        expect(providerProbe).toHaveBeenCalledOnce();
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
        expect(
            classifyAgentPermission('grok', {
                executable: 'grok',
                args: ['--yolo --sandbox workspace'],
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
