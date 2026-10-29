// oxlint-disable typescript/require-await -- Async domain fakes preserve the production Promise boundary.
import type { AgentChatTaskSnapshot } from '@caxri/protocol';
import { MOBILE_AGENT_CHAT_TASK_OUTPUT_MAX_BYTES } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { MobileAgentChatRequest } from '../agent-chat-requests';
import { isMobileAgentChatRead } from '../agent-chat-requests';
import { isMobileGatewayMethodAllowedForRole } from '../role-methods';
import { domainFixture, invoke } from './agent-chat-requests.fixture';

const taskSnapshot: AgentChatTaskSnapshot = {
    terminalId: 'terminal-1',
    taskId: 'task-1',
    revision: 2,
    truncated: false,
    items: [
        {
            id: 'item-1',
            type: 'fileChange',
            status: 'completed',
            changes: [{ path: '/work/demo/src/greeting.ts', kind: 'update', diff: '' }],
        },
    ],
    output: `${'x'.repeat(60_000)}done`,
};

/**
 * The shared Chat fixture plus `agentChat.readTask`, which only these requests reach.
 */
function taskDomain() {
    const domain = domainFixture({ surface: 'chat' });
    const chatRequest = domain.request.getMockImplementation()!;
    domain.request.mockImplementation(async (method, parameters) =>
        method === 'agentChat.readTask' ? taskSnapshot : chatRequest(method, parameters),
    );
    return domain;
}

describe('mobile Agent Chat background task requests', () => {
    it("reads one task's detail cut to one frame, naming files relative to the Project", async () => {
        const domain = taskDomain();
        const result = (await invoke(
            {
                method: 'mobile.agentChat.readTask',
                params: { terminalId: 'terminal-1', taskId: 'task-1' },
            },
            domain,
        )) as AgentChatTaskSnapshot;
        expect(domain.request).toHaveBeenCalledWith('agentChat.readTask', {
            terminalId: 'terminal-1',
            taskId: 'task-1',
        });
        expect(result.output?.endsWith('done')).toBe(true);
        expect(result.output!.length).toBeLessThanOrEqual(
            MOBILE_AGENT_CHAT_TASK_OUTPUT_MAX_BYTES + 1,
        );
        expect(result.items[0]).toMatchObject({ changes: [{ path: 'src/greeting.ts' }] });
    });

    it('forwards Stop for one task through Core admission', async () => {
        const forward = vi.fn<(operation: unknown) => Promise<null>>(async () => null);
        await invoke(
            {
                method: 'mobile.agentChat.stopTask',
                params: { terminalId: 'terminal-1', taskId: 'task-1' },
            },
            taskDomain(),
            forward,
        );
        expect(forward).toHaveBeenCalledWith({
            method: 'agentChat.stopTask',
            params: { terminalId: 'terminal-1', taskId: 'task-1' },
        });
    });

    it('forwards Start Building for a proposed plan to Core and leaves it to control devices', async () => {
        const forward = vi.fn<(operation: unknown) => Promise<null>>(async () => null);
        await invoke(
            {
                method: 'mobile.agentChat.implementPlan',
                params: { terminalId: 'terminal-1', itemId: 'plan-1' },
            },
            taskDomain(),
            forward,
        );
        expect(forward).toHaveBeenCalledWith({
            method: 'agentChat.implementPlan',
            params: { terminalId: 'terminal-1', itemId: 'plan-1' },
        });
        for (const role of ['view', 'reply'] as const)
            expect(
                isMobileGatewayMethodAllowedForRole(role, 'mobile.agentChat.implementPlan'),
            ).toBe(false);
        expect(
            isMobileGatewayMethodAllowedForRole('control', 'mobile.agentChat.implementPlan'),
        ).toBe(true);
    });

    it('refuses a task request for a Terminal that is not a Chat', async () => {
        await expect(
            invoke(
                {
                    method: 'mobile.agentChat.readTask',
                    params: { terminalId: 'terminal-1', taskId: 'task-1' },
                },
                domainFixture({}),
            ),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('lets every role read a task and only control devices stop one', () => {
        const read: MobileAgentChatRequest = {
            method: 'mobile.agentChat.readTask',
            params: { terminalId: 'terminal-1', taskId: 'task-1' },
        };
        expect(isMobileAgentChatRead(read)).toBe(true);
        expect(isMobileAgentChatRead({ ...read, method: 'mobile.agentChat.stopTask' })).toBe(false);
        for (const role of ['view', 'reply', 'control'] as const)
            expect(isMobileGatewayMethodAllowedForRole(role, 'mobile.agentChat.readTask')).toBe(
                true,
            );
        expect(isMobileGatewayMethodAllowedForRole('view', 'mobile.agentChat.stopTask')).toBe(
            false,
        );
        expect(isMobileGatewayMethodAllowedForRole('reply', 'mobile.agentChat.stopTask')).toBe(
            false,
        );
        expect(isMobileGatewayMethodAllowedForRole('control', 'mobile.agentChat.stopTask')).toBe(
            true,
        );
    });
});
