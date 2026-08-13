import { describe, expect, it, vi } from 'vitest';

import type {
    AgentEndpointBeginParams,
    AgentEndpointRetireParams,
} from '../../../shared/ipc/agent-endpoint-control';
import type { TerminalRecord } from '../../../shared/types';
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
        const lifecycle = new RuntimeAgentEndpointLifecycle({ begin, retire }, '/profile');

        await expect(
            lifecycle.environment(terminal(), 'project-1', { executable: 'codex', args: [] }),
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
                deliveryMode: 'pull',
            }),
        );
        await expect(
            lifecycle.environment(terminal('shell'), 'project-1', {
                executable: '/bin/zsh',
                args: [],
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
                retire,
            },
            '/profile',
        );
        const launch = { executable: 'codex', args: [] };
        await lifecycle.environment(terminal(), 'project-1', launch);
        await lifecycle.environment(terminal(), 'project-1', launch);

        expect(retire).toHaveBeenCalledTimes(1);
        expect(retire).toHaveBeenCalledWith(
            expect.objectContaining({
                ref: { hostId: 'host-1', endpointId: 'endpoint-1', generation: 1 },
            }),
        );
        expect(typeof retire.mock.calls[0]?.[0].launchId).toBe('string');
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
