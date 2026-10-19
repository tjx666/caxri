import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CommandExecutionContext } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TerminalExecutionPort } from '../../../domains/terminal';
import type { ServerDomainService } from '../../domain-service';
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

const open = async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-mobile-session-management-'));
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
    const sessions = [
        {
            id: 'session-granted',
            projectId: 'project-1',
            displayTitle: 'Granted',
            lastOpenedAt: 1,
            lastActivityState: 'completed',
            attentionEpoch: 0,
            hasUnread: false,
            archivedAt: 5,
        },
    ];
    const request = vi.fn(
        (method: string, parameters?: { query?: { mode: string; selector?: string } }) => {
            if (method === 'project.queryForPrincipal')
                return Promise.resolve({
                    projects: [
                        { id: 'project-1', displayTitle: 'Granted Project' },
                        { id: 'project-2', displayTitle: 'Other Project' },
                    ],
                });
            if (method === 'session.queryForPrincipal')
                return Promise.resolve({
                    sessions:
                        parameters?.query?.mode === 'show'
                            ? sessions.filter(({ id }) => id === parameters.query?.selector)
                            : sessions,
                });
            if (method === 'terminal.queryForPrincipal') return Promise.resolve({ terminals: [] });
            throw new Error(`Unexpected method: ${method}`);
        },
    );
    const requestWithSignal = vi.fn<(method: string, parameters: unknown) => Promise<unknown>>(() =>
        Promise.resolve({}),
    );
    const domainService = { request, requestWithSignal } as unknown as ServerDomainService;
    const context: CommandExecutionContext = { capabilities: [], principal };
    return { controller, context, domainService, requestWithSignal };
};

describe('MobileAccessController Session management', () => {
    it('forwards rename, archive, and restore to the Desktop Session handlers', async () => {
        const { controller, context, domainService, requestWithSignal } = await open();
        try {
            await expect(
                controller.invokeControl(
                    {
                        method: 'mobile.session.rename',
                        params: { sessionId: 'session-granted', displayTitle: 'Renamed' },
                    },
                    context,
                    domainService,
                ),
            ).resolves.toEqual({ sessionId: 'session-granted' });
            await controller.invokeControl(
                { method: 'mobile.session.archive', params: { sessionId: 'session-granted' } },
                context,
                domainService,
            );
            await controller.invokeControl(
                { method: 'mobile.session.restore', params: { sessionId: 'session-granted' } },
                context,
                domainService,
            );
            await controller.invokeControl(
                {
                    method: 'mobile.session.setPinned',
                    params: { sessionId: 'session-granted', pinned: true },
                },
                context,
                domainService,
            );
            expect(
                requestWithSignal.mock.calls.map(([method, parameters]) => [method, parameters]),
            ).toEqual([
                ['session.rename', { sessionId: 'session-granted', displayTitle: 'Renamed' }],
                ['session.archive', { sessionId: 'session-granted' }],
                ['session.unarchive', { sessionId: 'session-granted', placement: 'top' }],
                ['session.setPinned', { sessionId: 'session-granted', pinned: true }],
            ]);
        } finally {
            await controller.close();
        }
    });

    it('rejects a Session outside the grant without calling the Desktop handler', async () => {
        const { controller, context, domainService, requestWithSignal } = await open();
        try {
            await expect(
                controller.invokeControl(
                    { method: 'mobile.session.archive', params: { sessionId: 'session-hidden' } },
                    context,
                    domainService,
                ),
            ).rejects.toMatchObject({ code: 'NOT_FOUND' });
            expect(requestWithSignal).not.toHaveBeenCalled();
        } finally {
            await controller.close();
        }
    });

    it('lists archived Sessions only from granted Projects', async () => {
        const { controller, context, domainService } = await open();
        try {
            await expect(
                controller.invokeControl(
                    { method: 'mobile.session.archived', params: {} },
                    context,
                    domainService,
                ),
            ).resolves.toEqual({
                sessions: [
                    {
                        id: 'session-granted',
                        projectId: 'project-1',
                        displayTitle: 'Granted',
                        projectTitle: 'Granted Project',
                        archivedAt: 5,
                    },
                ],
                total: 1,
                truncated: false,
            });
        } finally {
            await controller.close();
        }
    });
});
