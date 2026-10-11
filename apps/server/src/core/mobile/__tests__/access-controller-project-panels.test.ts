import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CommandExecutionContext } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TerminalExecutionPort } from '../../../domains/terminal';
import type { ServerDomainService } from '../../domain-service';
import type { ExtensionService } from '../../extensions/service';
import { openMobileAccessController } from '../access-controller';
import { MobileDeviceRegistry } from '../device-registry';

const temporaryDirectories: string[] = [];
const terminalExecution = {
    onObserverEvent: () => () => {},
    onHostExit: () => () => {},
} as unknown as TerminalExecutionPort;

afterEach(async () => {
    const paths = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
});

describe('MobileAccessController Project add, read-only panels, tree, and files', () => {
    it('delegates Project add and durably grants it to the requesting device', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-mobile-project-add-'));
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
        controller.attach(
            { invoke: vi.fn() },
            'b'.repeat(32),
            { serverId: 'a'.repeat(32), stateEpoch: 'c'.repeat(32) },
            {} as ServerDomainService,
            terminalExecution,
            () => {},
        );
        const context: CommandExecutionContext = { capabilities: [], principal };
        const request = vi.fn((method: string) => {
            if (method === 'mobile.project.browseInternal')
                return Promise.resolve({
                    entries: [
                        {
                            name: 'demo',
                            relativePath: 'code/demo',
                            isGitRepository: true,
                            hasChildren: false,
                        },
                    ],
                    truncated: false,
                });
            if (method === 'mobile.project.addInternal')
                return Promise.resolve({
                    project: { id: 'project-2', displayTitle: 'Added Project' },
                });
            throw new Error(`Unexpected method: ${method}`);
        });
        const domainService = { request } as unknown as ServerDomainService;
        try {
            await expect(
                controller.invokeControl(
                    { method: 'mobile.project.browse', params: { path: 'code' } },
                    context,
                    domainService,
                ),
            ).resolves.toMatchObject({ entries: [{ name: 'demo' }], truncated: false });
            expect(request).toHaveBeenCalledWith('mobile.project.browseInternal', {
                path: 'code',
                principal,
            });
            await expect(
                controller.invokeControl(
                    { method: 'mobile.project.add', params: { path: 'code/demo' } },
                    context,
                    domainService,
                ),
            ).resolves.toEqual({ project: { id: 'project-2', displayTitle: 'Added Project' } });
            expect(request).toHaveBeenCalledWith('mobile.project.addInternal', {
                path: 'code/demo',
                principal,
            });
            const reopened = await MobileDeviceRegistry.open({ directory, path: registryPath });
            const granted = reopened.currentPrincipal(
                paired.device.deviceId,
                paired.device.generation,
            );
            if (granted.kind !== 'paired-device') throw new Error('Expected paired device');
            expect(granted.projectIds).toEqual(['project-1', 'project-2']);
        } finally {
            await controller.close();
        }
    });

    it('rejects Project files outside the granted Project scope', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-mobile-files-scope-'));
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
        controller.attach(
            { invoke: vi.fn() },
            'b'.repeat(32),
            { serverId: 'a'.repeat(32), stateEpoch: 'c'.repeat(32) },
            {} as ServerDomainService,
            terminalExecution,
            () => {},
        );
        const context: CommandExecutionContext = { capabilities: [], principal };
        const request = vi.fn((method: string, parameters?: { query?: { selector?: string } }) => {
            if (method === 'session.queryForPrincipal')
                return Promise.resolve({
                    sessions:
                        parameters?.query?.selector === 'session-1'
                            ? [{ id: 'session-1', projectId: 'project-1' }]
                            : [],
                });
            throw new Error(`Unexpected method: ${method}`);
        });
        const domainService = { request } as unknown as ServerDomainService;
        try {
            await expect(
                controller.invokeControl(
                    {
                        method: 'mobile.files.list',
                        params: { sessionId: 'session-out-of-scope', directory: '' },
                    },
                    context,
                    domainService,
                ),
            ).rejects.toMatchObject({ code: 'NOT_FOUND' });
            await expect(
                controller.invokeControl(
                    {
                        method: 'mobile.files.read',
                        params: { sessionId: 'session-out-of-scope', path: 'a.txt' },
                    },
                    context,
                    domainService,
                ),
            ).rejects.toMatchObject({ code: 'NOT_FOUND' });
            expect(request).not.toHaveBeenCalledWith(
                'mobile.files.listInternal',
                expect.anything(),
            );
            expect(request).not.toHaveBeenCalledWith(
                'mobile.files.readInternal',
                expect.anything(),
            );
        } finally {
            await controller.close();
        }
    });

    it('projects the secondary-sidebar panel catalog and drops a resource icon', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-mobile-panels-'));
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
        const extensionService = {
            catalog: () => ({
                revision: 1,
                containers: [
                    {
                        id: 'container-sidebar',
                        location: 'secondarySidebar',
                        source: 'core',
                        title: 'Source Control',
                        icon: { kind: 'resource', dataUrl: 'data:image/png;base64,AA==' },
                        commandId: 'workbench.view.sourceControl',
                        lifecycle: 'core',
                    },
                    {
                        id: 'container-panel',
                        location: 'panel',
                        source: 'core',
                        title: 'Problems',
                        icon: { kind: 'builtin', id: 'warning' },
                        commandId: 'workbench.view.problems',
                        lifecycle: 'core',
                    },
                ],
                views: [
                    {
                        id: 'view-changes',
                        containerId: 'container-sidebar',
                        source: 'core',
                        title: 'Changes',
                        viewKind: { kind: 'source-control' },
                        badge: true,
                    },
                    {
                        id: 'view-problems',
                        containerId: 'container-panel',
                        source: 'core',
                        title: 'Problems',
                        viewKind: { kind: 'source-control' },
                    },
                ],
                commands: [],
                extensions: [],
            }),
        } as unknown as ExtensionService;
        const controller = await openMobileAccessController({ directory, registryPath });
        controller.attach(
            { invoke: vi.fn() },
            'b'.repeat(32),
            { serverId: 'a'.repeat(32), stateEpoch: 'c'.repeat(32) },
            {} as ServerDomainService,
            terminalExecution,
            () => extensionService,
        );
        const context: CommandExecutionContext = { capabilities: [], principal };
        const request = vi.fn((method: string) => {
            if (method === 'session.queryForPrincipal')
                return Promise.resolve({ sessions: [{ id: 'session-1', projectId: 'project-1' }] });
            throw new Error(`Unexpected method: ${method}`);
        });
        const domainService = { request } as unknown as ServerDomainService;
        try {
            await expect(
                controller.invokeControl(
                    { method: 'mobile.panels.list', params: { sessionId: 'session-1' } },
                    context,
                    domainService,
                ),
            ).resolves.toEqual({
                panels: [
                    {
                        id: 'container-sidebar',
                        title: 'Source Control',
                        views: [
                            {
                                id: 'view-changes',
                                title: 'Changes',
                                kind: 'changes',
                                hasBadge: true,
                            },
                        ],
                    },
                ],
            });
        } finally {
            await controller.close();
        }
    });

    it('rejects Conversation Tree children for a Session Desktop is not focused on', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-mobile-tree-mismatch-'));
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
        const treeChildren = vi.fn();
        const extensionService = {
            treeChildren,
        } as unknown as ExtensionService;
        const controller = await openMobileAccessController({ directory, registryPath });
        controller.attach(
            { invoke: vi.fn() },
            'b'.repeat(32),
            { serverId: 'a'.repeat(32), stateEpoch: 'c'.repeat(32) },
            {} as ServerDomainService,
            terminalExecution,
            () => extensionService,
        );
        const context: CommandExecutionContext = { capabilities: [], principal };
        const request = vi.fn((method: string) => {
            if (method === 'session.queryForPrincipal')
                return Promise.resolve({ sessions: [{ id: 'session-1', projectId: 'project-1' }] });
            if (method === 'app.activeContext')
                return Promise.resolve({ sessionId: 'session-other' });
            throw new Error(`Unexpected method: ${method}`);
        });
        const domainService = { request } as unknown as ServerDomainService;
        try {
            await expect(
                controller.invokeControl(
                    {
                        method: 'mobile.tree.children',
                        params: { sessionId: 'session-1', viewId: 'view-changes' },
                    },
                    context,
                    domainService,
                ),
            ).rejects.toMatchObject({ code: 'CONFLICT' });
            expect(treeChildren).not.toHaveBeenCalled();
        } finally {
            await controller.close();
        }
    });

    it('reports a Desktop Session switch during a Conversation Tree read as CONFLICT', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-mobile-tree-switch-'));
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
        const treeChildren = vi
            .fn()
            .mockRejectedValue(new CaxriError('CANCELLED', 'The view context changed'));
        const extensionService = {
            treeChildren,
        } as unknown as ExtensionService;
        const controller = await openMobileAccessController({ directory, registryPath });
        controller.attach(
            { invoke: vi.fn() },
            'b'.repeat(32),
            { serverId: 'a'.repeat(32), stateEpoch: 'c'.repeat(32) },
            {} as ServerDomainService,
            terminalExecution,
            () => extensionService,
        );
        const context: CommandExecutionContext = { capabilities: [], principal };
        const request = vi.fn((method: string) => {
            if (method === 'session.queryForPrincipal')
                return Promise.resolve({ sessions: [{ id: 'session-1', projectId: 'project-1' }] });
            if (method === 'app.activeContext')
                return Promise.resolve({ sessionId: 'session-1', workbenchProjectId: 'project-1' });
            throw new Error(`Unexpected method: ${method}`);
        });
        const domainService = { request } as unknown as ServerDomainService;
        try {
            await expect(
                controller.invokeControl(
                    {
                        method: 'mobile.tree.children',
                        params: { sessionId: 'session-1', viewId: 'view-changes' },
                    },
                    context,
                    domainService,
                ),
            ).rejects.toMatchObject({ code: 'CONFLICT' });
            expect(treeChildren).toHaveBeenCalledOnce();
        } finally {
            await controller.close();
        }
    });

    it('projects Conversation Tree children for the active Session, dropping tooltip and a resource icon', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-mobile-tree-'));
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
        const treeChildren = vi.fn().mockResolvedValue({
            items: [
                {
                    handle: 'handle-1',
                    label: 'src',
                    description: '12 files',
                    tooltip: 'Never sent to mobile',
                    accessibilityLabel: 'src folder',
                    collapsibleState: 'collapsed',
                    icon: { kind: 'builtin', id: 'folder' },
                },
                {
                    handle: 'handle-2',
                    label: 'README.md',
                    accessibilityLabel: 'README.md file',
                    collapsibleState: 'none',
                    icon: { kind: 'resource', dataUrl: 'data:image/png;base64,AA==' },
                },
                {
                    handle: 'handle-3',
                    label: 'Fix login',
                    collapsibleState: 'none',
                    icon: { kind: 'theme', id: 'linear-started', color: '#f2c94c' },
                },
            ],
        });
        const extensionService = { treeChildren } as unknown as ExtensionService;
        const controller = await openMobileAccessController({ directory, registryPath });
        controller.attach(
            { invoke: vi.fn() },
            'b'.repeat(32),
            { serverId: 'a'.repeat(32), stateEpoch: 'c'.repeat(32) },
            {} as ServerDomainService,
            terminalExecution,
            () => extensionService,
        );
        const context: CommandExecutionContext = { capabilities: [], principal };
        const request = vi.fn((method: string) => {
            if (method === 'session.queryForPrincipal')
                return Promise.resolve({ sessions: [{ id: 'session-1', projectId: 'project-1' }] });
            if (method === 'app.activeContext')
                return Promise.resolve({ sessionId: 'session-1', workbenchProjectId: 'project-1' });
            throw new Error(`Unexpected method: ${method}`);
        });
        const domainService = { request } as unknown as ServerDomainService;
        try {
            await expect(
                controller.invokeControl(
                    {
                        method: 'mobile.tree.children',
                        params: { sessionId: 'session-1', viewId: 'view-changes' },
                    },
                    context,
                    domainService,
                ),
            ).resolves.toEqual({
                items: [
                    {
                        handle: 'handle-1',
                        label: 'src',
                        description: '12 files',
                        icon: { kind: 'builtin', id: 'folder' },
                        collapsibleState: 'collapsed',
                    },
                    {
                        handle: 'handle-2',
                        label: 'README.md',
                        collapsibleState: 'none',
                    },
                    {
                        handle: 'handle-3',
                        label: 'Fix login',
                        icon: { kind: 'theme', id: 'linear-started', color: '#f2c94c' },
                        collapsibleState: 'none',
                    },
                ],
            });
            expect(treeChildren).toHaveBeenCalledWith({
                viewId: 'view-changes',
                requestId: expect.any(String) as string,
                context: {
                    kind: 'session',
                    sessionId: 'session-1',
                    workbenchProjectId: 'project-1',
                },
            });
        } finally {
            await controller.close();
        }
    });
});
