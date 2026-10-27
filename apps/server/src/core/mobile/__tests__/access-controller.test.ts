import type { CommandExecutionContext } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { TerminalExecutionPort } from '../../../domains/terminal';
import { createMemoryMobileDeviceStore } from '../../__tests__/credential-stores.fixture';
import type { ServerDomainService } from '../../domain-service';
import { openMobileAccessController } from '../access-controller';
import { MobileDeviceRegistry } from '../device-registry';
import { mobileHostDisplayName } from '../host-display-name';
import { isMobileGatewayMethodAllowedForRole } from '../role-methods';

const terminalExecution = {
    onObserverEvent: () => () => {},
    onHostExit: () => () => {},
} as unknown as TerminalExecutionPort;

describe('MobileAccessController role and resource authority', () => {
    it('rejects a revoked device before answering or writing a file', async () => {
        const store = createMemoryMobileDeviceStore();
        const registry = MobileDeviceRegistry.open({ store });
        const paired = await registry.pair({
            displayName: 'Test phone',
            platform: 'ios',
            projectIds: ['project-1'],
        });
        const principal = registry.authenticate({
            credential: paired.credential,
            deviceId: paired.device.deviceId,
            generation: paired.device.generation,
        });
        const controller = openMobileAccessController({ store });
        const request = vi.fn();
        const domainService = { request } as unknown as ServerDomainService;
        controller.attach(
            { invoke: vi.fn() },
            'b'.repeat(32),
            { serverId: 'a'.repeat(32), stateEpoch: 'c'.repeat(32) },
            domainService,
            terminalExecution,
            () => {},
        );
        try {
            await controller.invokeDesktopOperation({
                method: 'mobile.device.revoke.apply',
                params: {
                    deviceId: paired.device.deviceId,
                    expectedGeneration: paired.device.generation,
                },
            });
            const context: CommandExecutionContext = { capabilities: [], principal };
            await expect(
                controller.invokeControl(
                    {
                        method: 'mobile.attention.answer',
                        params: {
                            sessionId: 'session-1',
                            requestId: 'request-1',
                            decision: 'allow',
                        },
                    },
                    context,
                    domainService,
                ),
            ).rejects.toMatchObject({ code: 'FORBIDDEN' });
            await expect(
                controller.invokeControl(
                    {
                        method: 'mobile.files.write',
                        params: {
                            sessionId: 'session-1',
                            path: '/project/notes.txt',
                            content: 'updated',
                            expectedContentHash: 'a'.repeat(64),
                        },
                    },
                    context,
                    domainService,
                ),
            ).rejects.toMatchObject({ code: 'FORBIDDEN' });
            expect(request).not.toHaveBeenCalled();
        } finally {
            await controller.close();
        }
    });

    it('revokes promptly while a mobile Session start is pending', async () => {
        const store = createMemoryMobileDeviceStore();
        const registry = MobileDeviceRegistry.open({ store });
        const paired = await registry.pair({
            displayName: 'Test phone',
            platform: 'ios',
            projectIds: ['project-1'],
        });
        const principal = registry.authenticate({
            credential: paired.credential,
            deviceId: paired.device.deviceId,
            generation: paired.device.generation,
        });
        const controller = openMobileAccessController({ store });
        controller.attach(
            { invoke: vi.fn() },
            'b'.repeat(32),
            {
                serverId: 'a'.repeat(32),
                stateEpoch: 'c'.repeat(32),
            },
            {} as ServerDomainService,
            terminalExecution,
            () => {},
        );
        const started = Promise.withResolvers<void>();
        const release = Promise.withResolvers<{ sessionId: string }>();
        let signal: AbortSignal | undefined;
        const request = vi.fn((method: string) => {
            if (method === 'project.queryForPrincipal')
                return Promise.resolve({ projects: [{ id: 'project-1' }] });
            if (method === 'mobile.session.createForPrincipal') {
                started.resolve();
                return release.promise;
            }
            throw new Error(`Unexpected method: ${method}`);
        });
        const requestWithSignal = vi.fn(
            (method: string, _parameters: unknown, incomingSignal: AbortSignal) => {
                if (method !== 'mobile.session.createForPrincipal')
                    throw new Error(`Unexpected method: ${method}`);
                signal = incomingSignal;
                started.resolve();
                return release.promise;
            },
        );
        const domainService = { request, requestWithSignal } as unknown as ServerDomainService;
        const context: CommandExecutionContext = { capabilities: [], principal };
        const create = controller.invokeControl(
            {
                method: 'mobile.session.create',
                params: { projectId: 'project-1', defaultAgent: 'codex' },
            },
            context,
            domainService,
        );
        try {
            await started.promise;
            let isRevoked = false;
            const revocation = controller.invokeDesktopOperation({
                method: 'mobile.device.revoke.apply',
                params: {
                    deviceId: paired.device.deviceId,
                    expectedGeneration: paired.device.generation,
                },
            });
            const observeRevocation = async (): Promise<void> => {
                await revocation;
                isRevoked = true;
            };
            const observedRevocation = observeRevocation();
            await vi.waitFor(() => expect(isRevoked).toBe(true), { timeout: 1_000 });
            expect(signal?.aborted).toBe(true);
            expect(() =>
                controller.authorizePairedDeviceMethod(principal, 'mobile.dashboard'),
            ).toThrow('Paired device authorization is unavailable');
            release.resolve({ sessionId: 'session-new' });
            await expect(create).rejects.toMatchObject({ code: 'CANCELLED' });
            await observedRevocation;
        } finally {
            release.resolve({ sessionId: 'session-new' });
            await Promise.allSettled([create]);
            await controller.close();
        }
    });

    it('sanitizes and bounds the Server-owned host label', () => {
        expect(mobileHostDisplayName('workstation.example.internal')).toBe('workstation');
        expect(mobileHostDisplayName('bad\nname')).toBe('badname');
        expect(mobileHostDisplayName('!')).toBe('Caxri Host');
        expect(mobileHostDisplayName('a'.repeat(200))).toHaveLength(100);
    });
    it('maps each role to an explicit method set', () => {
        expect(isMobileGatewayMethodAllowedForRole('view', 'mobile.dashboard')).toBe(true);
        expect(isMobileGatewayMethodAllowedForRole('view', 'terminal.preview')).toBe(true);
        expect(isMobileGatewayMethodAllowedForRole('view', 'terminal.send')).toBe(false);
        expect(isMobileGatewayMethodAllowedForRole('view', 'mobile.session.create')).toBe(false);
        expect(isMobileGatewayMethodAllowedForRole('view', 'mobile.terminal.input')).toBe(false);
        expect(isMobileGatewayMethodAllowedForRole('reply', 'terminal.send')).toBe(false);
        expect(isMobileGatewayMethodAllowedForRole('reply', 'mobile.agent.submit')).toBe(true);
        expect(isMobileGatewayMethodAllowedForRole('view', 'mobile.attention.list')).toBe(true);
        expect(isMobileGatewayMethodAllowedForRole('view', 'mobile.attention.answer')).toBe(false);
        expect(isMobileGatewayMethodAllowedForRole('reply', 'mobile.attention.answer')).toBe(false);
        expect(isMobileGatewayMethodAllowedForRole('control', 'mobile.attention.answer')).toBe(
            true,
        );
        expect(isMobileGatewayMethodAllowedForRole('view', 'mobile.agent.actions')).toBe(true);
        expect(isMobileGatewayMethodAllowedForRole('view', 'mobile.files.search')).toBe(true);
        expect(isMobileGatewayMethodAllowedForRole('view', 'mobile.files.write')).toBe(false);
        expect(isMobileGatewayMethodAllowedForRole('reply', 'mobile.files.write')).toBe(false);
        expect(isMobileGatewayMethodAllowedForRole('control', 'mobile.files.write')).toBe(true);
        expect(isMobileGatewayMethodAllowedForRole('view', 'mobile.image.upload')).toBe(false);
        expect(isMobileGatewayMethodAllowedForRole('reply', 'mobile.image.upload')).toBe(true);
        expect(isMobileGatewayMethodAllowedForRole('reply', 'agent.control.interrupt')).toBe(false);
        expect(isMobileGatewayMethodAllowedForRole('view', 'mobile.changes.list')).toBe(true);
        expect(isMobileGatewayMethodAllowedForRole('view', 'mobile.changes.diff')).toBe(true);
        expect(isMobileGatewayMethodAllowedForRole('reply', 'session.markRead')).toBe(true);
        expect(isMobileGatewayMethodAllowedForRole('reply', 'mobile.session.create')).toBe(false);
        expect(isMobileGatewayMethodAllowedForRole('reply', 'mobile.terminal.takeOver')).toBe(
            false,
        );
        expect(isMobileGatewayMethodAllowedForRole('view', 'mobile.terminal.scroll')).toBe(false);
        expect(isMobileGatewayMethodAllowedForRole('reply', 'mobile.terminal.scroll')).toBe(false);
        expect(isMobileGatewayMethodAllowedForRole('control', 'mobile.session.create')).toBe(true);
        expect(isMobileGatewayMethodAllowedForRole('control', 'agent.control.interrupt')).toBe(
            true,
        );
        for (const method of [
            'mobile.terminal.takeOver',
            'mobile.terminal.release',
            'mobile.terminal.input',
            'mobile.terminal.scroll',
        ])
            expect(isMobileGatewayMethodAllowedForRole('control', method)).toBe(true);
        expect(isMobileGatewayMethodAllowedForRole('control', 'session.create')).toBe(false);
        for (const method of [
            'mobile.session.rename',
            'mobile.session.archive',
            'mobile.session.restore',
            'mobile.session.setPinned',
        ]) {
            expect(isMobileGatewayMethodAllowedForRole('view', method)).toBe(false);
            expect(isMobileGatewayMethodAllowedForRole('reply', method)).toBe(false);
            expect(isMobileGatewayMethodAllowedForRole('control', method)).toBe(true);
        }
        for (const role of ['view', 'reply', 'control'] as const)
            expect(isMobileGatewayMethodAllowedForRole(role, 'mobile.session.archived')).toBe(true);
        for (const method of ['mobile.project.browse', 'mobile.project.add']) {
            expect(isMobileGatewayMethodAllowedForRole('view', method)).toBe(false);
            expect(isMobileGatewayMethodAllowedForRole('reply', method)).toBe(false);
            expect(isMobileGatewayMethodAllowedForRole('control', method)).toBe(true);
        }
        for (const method of [
            'mobile.panels.list',
            'mobile.tree.children',
            'mobile.files.list',
            'mobile.files.read',
        ]) {
            expect(isMobileGatewayMethodAllowedForRole('view', method)).toBe(true);
            expect(isMobileGatewayMethodAllowedForRole('reply', method)).toBe(true);
            expect(isMobileGatewayMethodAllowedForRole('control', method)).toBe(true);
        }
    });

    it('rejects a mobile control method with no implementation', async () => {
        const store = createMemoryMobileDeviceStore();
        const controller = openMobileAccessController({
            store,
        });
        const domainService = {} as ServerDomainService;
        controller.attach(
            { invoke: vi.fn() },
            'b'.repeat(32),
            { serverId: 'a'.repeat(32), stateEpoch: 'c'.repeat(32) },
            domainService,
            terminalExecution,
            () => {},
        );
        try {
            const futureRequest = {
                method: 'mobile.futureControl',
                params: {},
            } as unknown as Parameters<typeof controller.invokeControl>[0];
            await expect(
                controller.invokeControl(
                    futureRequest,
                    {} as CommandExecutionContext,
                    domainService,
                ),
            ).rejects.toMatchObject({ code: 'INTERNAL' });
        } finally {
            await controller.close();
        }
    });

    it('rejects a Project outside the grant and a revoked generation', async () => {
        const store = createMemoryMobileDeviceStore();
        const registry = MobileDeviceRegistry.open({ store });
        const paired = await registry.pair({
            displayName: 'Test phone',
            platform: 'ios',
            projectIds: ['project-1'],
        });
        const principal = registry.authenticate({
            credential: paired.credential,
            deviceId: paired.device.deviceId,
            generation: paired.device.generation,
        });
        if (principal.kind !== 'paired-device') throw new Error('Expected paired device');
        const controller = openMobileAccessController({
            store,
            hostDisplayName: 'Caxri Test Host',
        });
        controller.attach(
            { invoke: vi.fn() },
            'b'.repeat(32),
            {
                serverId: 'a'.repeat(32),
                stateEpoch: 'c'.repeat(32),
            },
            {} as ServerDomainService,
            terminalExecution,
            () => {},
        );
        const context: CommandExecutionContext = { capabilities: [], principal };
        const request = vi.fn(
            (method: string, parameters?: { query?: { mode: string; selector?: string } }) => {
                if (method === 'project.queryForPrincipal')
                    return Promise.resolve({
                        projects:
                            parameters?.query?.mode === 'list'
                                ? [
                                      { id: 'project-1', title: 'Granted empty' },
                                      { id: 'project-2', title: 'Other Project' },
                                  ]
                                : [{ id: 'project-1', title: 'Granted empty' }],
                    });
                if (method === 'session.queryForPrincipal')
                    return Promise.resolve({
                        sessions:
                            parameters?.query?.selector === 'session-deep'
                                ? [
                                      {
                                          id: 'session-deep',
                                          projectId: 'project-1',
                                          title: 'Deep Session',
                                          lastVisitedAt: 7,
                                          agentActivityState: 'running',
                                          primaryAgentTerminalId: 'terminal-deep',
                                          attentionGeneration: 0,
                                          hasUnread: false,
                                      },
                                  ]
                                : [],
                    });
                if (method === 'terminal.queryForPrincipal')
                    return Promise.resolve({
                        terminals:
                            parameters?.query?.selector === 'terminal-deep'
                                ? [
                                      {
                                          id: 'terminal-deep',
                                          sessionId: 'session-deep',
                                          kind: 'codex',
                                          provider: 'codex',
                                          lastProcessState: 'running',
                                      },
                                  ]
                                : [],
                    });
                throw new Error(`Unexpected method: ${method}`);
            },
        );
        const requestWithSignal = vi.fn((...arguments_: [string, unknown, AbortSignal]) => {
            if (arguments_[0] !== 'mobile.session.createForPrincipal')
                throw new Error(`Unexpected method: ${arguments_[0]}`);
            return Promise.resolve({ sessionId: 'session-new' });
        });
        const domainService = { request, requestWithSignal } as unknown as ServerDomainService;
        try {
            /**
             * `isMobileControlRequest` intercepts every `mobile.*` method before `validatePairedDeviceRequest` ever
             * runs, so `mobile.session.create`'s own out-of-grant Project check lives in `invokeControl` instead; this
             * exercises that reachable path directly rather than the unreachable one.
             */
            await expect(
                controller.invokeControl(
                    {
                        method: 'mobile.session.create',
                        params: { projectId: 'project-2', defaultAgent: 'codex' },
                    },
                    context,
                    domainService,
                ),
            ).rejects.toMatchObject({ code: 'NOT_FOUND' });
            expect(request).not.toHaveBeenCalled();
            expect(requestWithSignal).not.toHaveBeenCalled();
            expect(() =>
                controller.authorizePairedDeviceMethod(
                    { ...principal, role: 'view' },
                    'terminal.preview',
                ),
            ).toThrow('Paired device authorization changed');
            await expect(
                controller.invokeControl(
                    {
                        method: 'mobile.session.create',
                        params: { projectId: 'project-1', defaultAgent: 'codex' },
                    },
                    context,
                    domainService,
                ),
            ).resolves.toEqual({ sessionId: 'session-new' });
            expect(requestWithSignal.mock.calls[0]?.[0]).toBe('mobile.session.createForPrincipal');
            expect(requestWithSignal.mock.calls[0]?.[1]).toEqual({
                projectId: 'project-1',
                defaultAgent: 'codex',
                principal,
            });
            expect(requestWithSignal.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
            const dashboard = await controller.invokeControl(
                { method: 'mobile.dashboard', params: {} },
                context,
                domainService,
            );
            expect(dashboard).toMatchObject({
                hostDisplayName: 'Caxri Test Host',
                deviceRole: 'control',
                projects: [{ id: 'project-1', title: 'Granted empty' }],
                sessions: [],
            });
            await expect(
                controller.invokeControl(
                    { method: 'mobile.session.show', params: { sessionId: 'session-deep' } },
                    context,
                    domainService,
                    (terminalId) =>
                        terminalId === 'terminal-deep'
                            ? { hostId: 'host-1', endpointId: 'endpoint-1', generation: 1 }
                            : undefined,
                ),
            ).resolves.toMatchObject({
                session: {
                    id: 'session-deep',
                    primaryAgentEndpoint: {
                        hostId: 'host-1',
                        endpointId: 'endpoint-1',
                        generation: 1,
                    },
                },
            });
            await expect(
                controller.invokeControl(
                    { method: 'mobile.session.show', params: { sessionId: 'session-other' } },
                    context,
                    domainService,
                ),
            ).rejects.toMatchObject({ code: 'NOT_FOUND' });
            await controller.invokeDesktopOperation({
                method: 'mobile.device.revoke.apply',
                params: {
                    deviceId: paired.device.deviceId,
                    expectedGeneration: paired.device.generation,
                },
            });
            await expect(
                controller.validatePairedDeviceRequest(
                    { method: 'terminal.preview', params: { terminalId: 'terminal-deep' } },
                    context,
                    domainService,
                ),
            ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        } finally {
            await controller.close();
        }
    });
});

describe('MobileAccessController Agent submissions', () => {
    it('forwards one paired submission and cancels pending work after device revocation', async () => {
        const store = createMemoryMobileDeviceStore();
        const registry = MobileDeviceRegistry.open({ store });
        const paired = await registry.pair({
            displayName: 'Test phone',
            platform: 'android',
            projectIds: ['project-1'],
        });
        const principal = registry.authenticate({
            credential: paired.credential,
            deviceId: paired.device.deviceId,
            generation: paired.device.generation,
        });
        const controller = openMobileAccessController({
            store,
            selectAddress: () => '127.0.0.1',
        });
        controller.attach(
            { invoke: vi.fn() },
            'b'.repeat(32),
            { serverId: 'a'.repeat(32), stateEpoch: 'c'.repeat(32) },
            {} as ServerDomainService,
            terminalExecution,
            () => {},
        );
        const context: CommandExecutionContext = { capabilities: [], principal };
        const endpoint = { hostId: 'host-1', endpointId: 'endpoint-1', generation: 1 };
        const parameters = {
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            endpoint,
            clientMutationId: 'mutation-1',
            text: '你好\ncontinue',
        };
        const started = Promise.withResolvers<void>();
        const release = Promise.withResolvers<{ terminalId: string; outcome: 'accepted' }>();
        const requestWithSignal = vi.fn(
            (method: string, _parameters: unknown, signal: AbortSignal) => {
                expect(method).toBe('mobile.agent.submitInternal');
                expect(signal.aborted).toBe(false);
                started.resolve();
                return release.promise;
            },
        );
        const domainService = { requestWithSignal } as unknown as ServerDomainService;
        try {
            await controller.invokeControl(
                { method: 'mobile.access.enable', params: {} },
                context,
                domainService,
            );
            const pending = controller.invokeControl(
                { method: 'mobile.agent.submit', params: parameters },
                context,
                domainService,
            );
            await started.promise;
            expect(requestWithSignal.mock.calls[0]?.[1]).toEqual({ ...parameters, principal });
            await controller.invokeDesktopOperation({
                method: 'mobile.device.revoke.apply',
                params: {
                    deviceId: paired.device.deviceId,
                    expectedGeneration: paired.device.generation,
                },
            });
            release.resolve({ terminalId: 'terminal-1', outcome: 'accepted' });
            await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
            await expect(
                controller.invokeControl(
                    { method: 'mobile.agent.submit', params: parameters },
                    context,
                    domainService,
                ),
            ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        } finally {
            release.resolve({ terminalId: 'terminal-1', outcome: 'accepted' });
            await controller.close();
        }
    });
});
