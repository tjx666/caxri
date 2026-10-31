import type { CommandExecutionContext } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { TerminalExecutionPort } from '../../../domains/terminal';
import { createMemoryMobileDeviceStore } from '../../__tests__/credential-stores.fixture';
import type { ServerDomainService } from '../../domain-service';
import type { ExtensionService } from '../../extensions/service';
import { openMobileAccessController } from '../access-controller';
import { MobileDeviceRegistry } from '../device-registry';

const terminalExecution = {
    onObserverEvent: () => () => {},
    onHostExit: () => () => {},
} as unknown as TerminalExecutionPort;

describe('MobileAccessController Project add, read-only panels, tree, and files', () => {
    it('delegates Project add and durably grants it to the requesting device', async () => {
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
                    project: { id: 'project-2', title: 'Added Project' },
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
            ).resolves.toEqual({ project: { id: 'project-2', title: 'Added Project' } });
            expect(request).toHaveBeenCalledWith('mobile.project.addInternal', {
                path: 'code/demo',
                principal,
            });
            const reopened = MobileDeviceRegistry.open({ store });
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

    it('maps a granted Project reorder onto the full top-level Project order', async () => {
        const store = createMemoryMobileDeviceStore();
        const registry = MobileDeviceRegistry.open({ store });
        const paired = await registry.pair({
            displayName: 'Test phone',
            platform: 'ios',
            projectIds: ['project-1', 'project-3'],
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
            { serverId: 'a'.repeat(32), stateEpoch: 'c'.repeat(32) },
            {} as ServerDomainService,
            terminalExecution,
            () => {},
        );
        const context: CommandExecutionContext = { capabilities: [], principal };
        const request = vi.fn((method: string) => {
            if (method === 'project.list')
                return Promise.resolve({
                    projects: [
                        { id: 'project-1', title: 'One' },
                        { id: 'project-worktree', title: 'Worktree', ownerProjectId: 'project-1' },
                        { id: 'project-2', title: 'Hidden' },
                        { id: 'project-3', title: 'Three' },
                    ],
                });
            if (method === 'project.reorder') return Promise.resolve([]);
            throw new Error(`Unexpected method: ${method}`);
        });
        const domainService = { request } as unknown as ServerDomainService;
        try {
            await expect(
                controller.invokeControl(
                    {
                        method: 'mobile.project.reorder',
                        params: {
                            projectId: 'project-3',
                            anchorProjectId: 'project-1',
                            placement: 'before',
                        },
                    },
                    context,
                    domainService,
                ),
            ).resolves.toBeNull();
            expect(request).toHaveBeenCalledWith('project.reorder', {
                projectId: 'project-3',
                targetIndex: 0,
            });
            await expect(
                controller.invokeControl(
                    {
                        method: 'mobile.project.reorder',
                        params: {
                            projectId: 'project-1',
                            anchorProjectId: 'project-2',
                            placement: 'after',
                        },
                    },
                    context,
                    domainService,
                ),
            ).rejects.toMatchObject({ code: 'NOT_FOUND' });
            expect(request).toHaveBeenCalledTimes(2);
        } finally {
            await controller.close();
        }
    });

    it('rejects Project files outside the granted Project scope', async () => {
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
        const controller = openMobileAccessController({ store });
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

    it('reports a Session that no longer resolves as unavailable instead of reading the tree', async () => {
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
        const treeChildren = vi.fn();
        const extensionService = {
            treeChildren,
        } as unknown as ExtensionService;
        const controller = openMobileAccessController({ store });
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
            if (method === 'app.sessionContext') return Promise.resolve({ projectIds: [] });
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
            ).rejects.toMatchObject({ code: 'NOT_FOUND' });
            expect(treeChildren).not.toHaveBeenCalled();
        } finally {
            await controller.close();
        }
    });

    it('surfaces a Workbench Root change during a Conversation Tree read as cancellation', async () => {
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
        const treeChildren = vi
            .fn()
            .mockRejectedValue(new CaxriError('CANCELLED', 'The view context changed'));
        const extensionService = {
            treeChildren,
        } as unknown as ExtensionService;
        const controller = openMobileAccessController({ store });
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
            if (method === 'app.sessionContext')
                return Promise.resolve({
                    projectIds: ['project-1'],
                    sessionId: 'session-1',
                    workbenchRootProjectId: 'project-1',
                });
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
            ).rejects.toMatchObject({ code: 'CANCELLED' });
            expect(treeChildren).toHaveBeenCalledOnce();
        } finally {
            await controller.close();
        }
    });

    /**
     * The phone reads the Session it shows. `app.activeContext` (the focused Desktop window) is never consulted, so a
     * Session Desktop is not showing still loads instead of asking the user to open it on the computer.
     */
    it('projects Conversation Tree children for the requested Session, dropping tooltip and a resource icon', async () => {
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
        const controller = openMobileAccessController({ store });
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
            if (method === 'app.sessionContext')
                return Promise.resolve({
                    projectIds: ['project-1'],
                    sessionId: 'session-1',
                    workbenchRootProjectId: 'project-1',
                });
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
                    workbenchRootProjectId: 'project-1',
                },
            });
        } finally {
            await controller.close();
        }
    });
});
