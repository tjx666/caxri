import type { CommandExecutionContext } from '@caxri/protocol';
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

describe('MobileAccessController tree actions', () => {
    /**
     * A phone tree row's inline action, such as a submodule pull request's `Merge`, runs the same Extension command
     * Desktop runs, scoped to the Session the phone shows.
     */
    it('runs a tree action command for the requested Session', async () => {
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
        const executeCommand = vi
            .fn()
            .mockResolvedValue({ executed: true, message: 'Squash-merged #7' });
        const extensionService = { executeCommand } as unknown as ExtensionService;
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
        const target = { repositoryId: 'repo-submodule', number: 7, headSha: 'f'.repeat(40) };
        try {
            await expect(
                controller.invokeControl(
                    {
                        method: 'mobile.tree.executeCommand',
                        params: {
                            sessionId: 'session-1',
                            commandId: 'caxri.project-status.mergePullRequest',
                            arguments: [target],
                        },
                    },
                    context,
                    domainService,
                ),
            ).resolves.toEqual({ executed: true, message: 'Squash-merged #7' });
            expect(executeCommand).toHaveBeenCalledWith(
                'caxri.project-status.mergePullRequest',
                [target],
                { kind: 'session', sessionId: 'session-1', workbenchRootProjectId: 'project-1' },
            );
        } finally {
            await controller.close();
        }
    });
});
