import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CommandExecutionContext } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ServerDomainService } from '../../domain-service';
import {
    isMobileGatewayMethodAllowedForRole,
    mobileHostDisplayName,
    openMobileAccessController,
} from '../access-controller';
import { MobileDeviceRegistry } from '../device-registry';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const paths = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
});

describe('MobileAccessController role and resource authority', () => {
    it('revokes promptly while a mobile Session start is pending', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-mobile-create-revoke-'));
        temporaryDirectories.push(directory);
        const registryPath = join(directory, 'mobile-devices.json');
        const registry = await MobileDeviceRegistry.open({ directory, path: registryPath });
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
        const controller = await openMobileAccessController({ directory, registryPath });
        controller.attach({ invoke: vi.fn() }, 'b'.repeat(32), {
            serverId: 'a'.repeat(32),
            stateEpoch: 'c'.repeat(32),
        });
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
        expect(isMobileGatewayMethodAllowedForRole('reply', 'terminal.send')).toBe(true);
        expect(isMobileGatewayMethodAllowedForRole('reply', 'session.markRead')).toBe(true);
        expect(isMobileGatewayMethodAllowedForRole('reply', 'mobile.session.create')).toBe(false);
        expect(isMobileGatewayMethodAllowedForRole('control', 'mobile.session.create')).toBe(true);
        expect(isMobileGatewayMethodAllowedForRole('control', 'session.create')).toBe(false);
    });

    it('rejects a Project outside the grant and a revoked generation', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-mobile-authority-'));
        temporaryDirectories.push(directory);
        const registryPath = join(directory, 'mobile-devices.json');
        const registry = await MobileDeviceRegistry.open({ directory, path: registryPath });
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
        const controller = await openMobileAccessController({
            directory,
            registryPath,
            hostDisplayName: 'Caxri Test Host',
        });
        controller.attach({ invoke: vi.fn() }, 'b'.repeat(32), {
            serverId: 'a'.repeat(32),
            stateEpoch: 'c'.repeat(32),
        });
        const context: CommandExecutionContext = { capabilities: [], principal };
        const request = vi.fn((method: string, parameters?: { query?: { mode: string } }) => {
            if (method === 'project.queryForPrincipal')
                return Promise.resolve({
                    projects:
                        parameters?.query?.mode === 'list'
                            ? [
                                  { id: 'project-1', displayTitle: 'Granted empty' },
                                  { id: 'project-2', displayTitle: 'Other Project' },
                              ]
                            : [{ id: 'project-1', displayTitle: 'Granted empty' }],
                });
            if (method === 'session.queryForPrincipal') return Promise.resolve({ sessions: [] });
            if (method === 'terminal.queryForPrincipal') return Promise.resolve({ terminals: [] });
            throw new Error(`Unexpected method: ${method}`);
        });
        const requestWithSignal = vi.fn((...arguments_: [string, unknown, AbortSignal]) => {
            if (arguments_[0] !== 'mobile.session.createForPrincipal')
                throw new Error(`Unexpected method: ${arguments_[0]}`);
            return Promise.resolve({ sessionId: 'session-new' });
        });
        const domainService = { request, requestWithSignal } as unknown as ServerDomainService;
        try {
            await expect(
                controller.validatePairedDeviceRequest(
                    {
                        method: 'mobile.session.create',
                        params: { projectId: 'project-2', defaultAgent: 'codex' },
                    },
                    context,
                    domainService,
                ),
            ).rejects.toMatchObject({ code: 'NOT_FOUND' });
            expect(request).not.toHaveBeenCalled();
            await expect(
                controller.validatePairedDeviceRequest(
                    {
                        method: 'mobile.session.create',
                        params: { projectId: 'project-1', defaultAgent: 'codex' },
                    },
                    context,
                    domainService,
                ),
            ).resolves.toBeUndefined();
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
                projects: [{ id: 'project-1', displayTitle: 'Granted empty' }],
                sessions: [],
            });
            await controller.invokeDesktopOperation({
                method: 'mobile.device.revoke.apply',
                params: {
                    deviceId: paired.device.deviceId,
                    expectedGeneration: paired.device.generation,
                },
            });
            await expect(
                controller.validatePairedDeviceRequest(
                    {
                        method: 'mobile.session.create',
                        params: { projectId: 'project-1', defaultAgent: 'codex' },
                    },
                    context,
                    domainService,
                ),
            ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        } finally {
            await controller.close();
        }
    });
});

describe('MobileAccessController short replies', () => {
    it('accepts only the current attention event on the primary waiting Agent Terminal', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-mobile-access-controller-'));
        temporaryDirectories.push(directory);
        const registryPath = join(directory, 'mobile-devices.json');
        const registry = await MobileDeviceRegistry.open({ directory, path: registryPath });
        const paired = await registry.pair({
            displayName: 'Test tablet',
            platform: 'android',
            projectIds: ['project-1'],
        });
        const principal = registry.authenticate({
            credential: paired.credential,
            deviceId: paired.device.deviceId,
            generation: paired.device.generation,
        });
        const controller = await openMobileAccessController({
            directory,
            registryPath,
            selectAddress: () => '127.0.0.1',
        });
        controller.attach({ invoke: vi.fn() }, 'b'.repeat(32), {
            serverId: 'a'.repeat(32),
            stateEpoch: 'c'.repeat(32),
        });

        const terminal = {
            id: 'terminal-agent',
            kind: 'agent',
            sessionId: 'session-1',
        };
        const session = {
            id: 'session-1',
            attentionEpoch: 7,
            lastActivityState: 'waiting',
            primaryAgentTerminalId: terminal.id,
        };
        const request = vi.fn((method: string) => {
            if (method === 'terminal.queryForPrincipal')
                return Promise.resolve({ terminals: [terminal] });
            if (method === 'session.queryForPrincipal')
                return Promise.resolve({ sessions: [session] });
            throw new Error(`Unexpected method: ${method}`);
        });
        const domainService = { request } as unknown as ServerDomainService;
        const context: CommandExecutionContext = {
            capabilities: ['projects.read', 'sessions.read', 'terminals.read', 'terminals.steer'],
            principal,
        };
        const valid = {
            attentionEpoch: 7,
            enter: true,
            terminalId: terminal.id,
            text: 'continue',
        };

        try {
            await controller.invokeControl(
                { method: 'mobile.access.enable', params: {} },
                context,
                domainService,
            );
            await expect(
                controller.invokeShortReply(context, valid, domainService, () => Promise.resolve()),
            ).resolves.toBeUndefined();

            await expect(
                controller.invokeShortReply(
                    context,
                    { ...valid, enter: false },
                    domainService,
                    () => Promise.resolve(),
                ),
            ).rejects.toMatchObject({ code: 'VALIDATION' });
            await expect(
                controller.invokeShortReply(context, { ...valid, text: '\t' }, domainService, () =>
                    Promise.resolve(),
                ),
            ).rejects.toMatchObject({ code: 'VALIDATION' });
            await expect(
                controller.invokeShortReply(
                    context,
                    { ...valid, text: ' '.repeat(3) },
                    domainService,
                    () => Promise.resolve(),
                ),
            ).rejects.toMatchObject({ code: 'VALIDATION' });
            await expect(
                controller.invokeShortReply(
                    context,
                    { ...valid, attentionEpoch: undefined },
                    domainService,
                    () => Promise.resolve(),
                ),
            ).rejects.toMatchObject({ code: 'VALIDATION' });
            await expect(
                controller.invokeShortReply(
                    context,
                    { ...valid, text: '🙂'.repeat(257) },
                    domainService,
                    () => Promise.resolve(),
                ),
            ).rejects.toMatchObject({ code: 'VALIDATION' });
            await expect(
                controller.invokeShortReply(
                    context,
                    { ...valid, attentionEpoch: 6 },
                    domainService,
                    () => Promise.resolve(),
                ),
            ).rejects.toMatchObject({ code: 'CONFLICT' });

            terminal.kind = 'shell';
            await expect(
                controller.invokeShortReply(context, valid, domainService, () => Promise.resolve()),
            ).rejects.toMatchObject({ code: 'CONFLICT' });
            terminal.kind = 'agent';
            session.primaryAgentTerminalId = 'terminal-secondary';
            await expect(
                controller.invokeShortReply(context, valid, domainService, () => Promise.resolve()),
            ).rejects.toMatchObject({ code: 'CONFLICT' });
            session.primaryAgentTerminalId = terminal.id;
            session.lastActivityState = 'running';
            await expect(
                controller.invokeShortReply(context, valid, domainService, () => Promise.resolve()),
            ).rejects.toMatchObject({ code: 'CONFLICT' });
            session.lastActivityState = 'waiting';

            const delivery = Promise.withResolvers<void>();
            let isDeliveryStarted = false;
            let didWriteAfterRevocation = false;
            const inFlight = controller.invokeShortReply(
                context,
                valid,
                domainService,
                async (signal?: AbortSignal) => {
                    isDeliveryStarted = true;
                    await delivery.promise;
                    if (!signal?.aborted) didWriteAfterRevocation = true;
                },
            );
            await vi.waitFor(() => expect(isDeliveryStarted).toBe(true));
            let isRevocationSettled = false;
            const revocation = controller.invokeDesktopOperation({
                method: 'mobile.device.revoke.apply',
                params: {
                    deviceId: paired.device.deviceId,
                    expectedGeneration: paired.device.generation,
                },
            });
            const observeRevocation = async (): Promise<void> => {
                await revocation;
                isRevocationSettled = true;
            };
            const observedRevocation = observeRevocation();
            await vi.waitFor(() => expect(isRevocationSettled).toBe(true), { timeout: 1_000 });
            expect(() =>
                controller.authorizePairedDeviceMethod(principal, 'terminal.send'),
            ).toThrow('Paired device authorization is unavailable');
            delivery.resolve();
            await expect(inFlight).rejects.toMatchObject({ code: 'CANCELLED' });
            expect(didWriteAfterRevocation).toBe(false);
            await observedRevocation;
            await expect(
                controller.invokeShortReply(context, valid, domainService, () => Promise.resolve()),
            ).rejects.toMatchObject({ code: 'FORBIDDEN' });
            const closing = controller.close();
            const enableAfterClose = controller.invokeControl(
                { method: 'mobile.access.enable', params: {} },
                context,
                domainService,
            );
            await closing;
            await expect(enableAfterClose).rejects.toMatchObject({ code: 'UNAVAILABLE' });
        } finally {
            await controller.close();
        }
    });
});
