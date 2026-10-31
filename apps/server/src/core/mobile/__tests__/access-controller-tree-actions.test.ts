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

    /**
     * `caxri.sendToAgent` is a Workbench command Desktop's Renderer resolves; for a phone Server Core sends the prompt
     * to the Session's Agent Chat through the forwarded `agentChat.send`, and never reaches the Extension Host.
     */
    it('sends a Resolve prompt to the Session Agent Chat through the forwarded operation', async () => {
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
        const executeCommand = vi.fn();
        const controller = openMobileAccessController({ store });
        controller.attach(
            { invoke: vi.fn() },
            'b'.repeat(32),
            { serverId: 'a'.repeat(32), stateEpoch: 'c'.repeat(32) },
            {} as ServerDomainService,
            terminalExecution,
            () => ({ executeCommand }) as unknown as ExtensionService,
        );
        const request = vi.fn((method: string) => {
            if (method === 'session.queryForPrincipal')
                return Promise.resolve({
                    sessions: [
                        {
                            id: 'session-1',
                            projectId: 'project-1',
                            primaryAgentTerminalId: 'chat-1',
                        },
                    ],
                });
            if (method === 'app.sessionContext')
                return Promise.resolve({
                    projectIds: ['project-1'],
                    sessionId: 'session-1',
                    workbenchRootProjectId: 'project-1',
                });
            if (method === 'terminal.queryForPrincipal')
                return Promise.resolve({
                    terminals: [
                        {
                            id: 'chat-1',
                            sessionId: 'session-1',
                            kind: 'claude',
                            provider: 'claude',
                            surface: 'chat',
                        },
                    ],
                });
            throw new Error(`Unexpected method: ${method}`);
        });
        const forward = vi.fn(() => Promise.resolve(null));
        try {
            await expect(
                controller.invokeControl(
                    {
                        method: 'mobile.tree.executeCommand',
                        params: {
                            sessionId: 'session-1',
                            commandId: 'caxri.sendToAgent',
                            arguments: ['Resolve the conflicts'],
                        },
                    },
                    { capabilities: [], principal },
                    { request } as unknown as ServerDomainService,
                    undefined,
                    forward,
                ),
            ).resolves.toEqual({ executed: true, message: 'Sent to Claude' });
            expect(forward).toHaveBeenCalledWith({
                method: 'agentChat.send',
                params: { terminalId: 'chat-1', text: 'Resolve the conflicts' },
            });
            expect(executeCommand).not.toHaveBeenCalled();
        } finally {
            await controller.close();
        }
    });
});
