import { describe, expect, it, vi } from 'vitest';

import type { AgentChatSessionHost } from '../chat-provider';
import { ClaudeTaskFeedback } from '../claude-task-feedback';

const hook = (name: string) => ({
    type: 'system',
    subtype: 'hook_response',
    hook_name: name,
    exit_code: 2,
    outcome: 'error',
    stderr: 'Blocked by a display test Hook.',
});

function feedback() {
    let now = 1_000;
    const applyTask = vi.fn();
    const host = { applyTask } as unknown as AgentChatSessionHost;
    const routing = new ClaudeTaskFeedback(host, () => now);
    return { applyTask, routing, advance: (ms: number) => (now += ms) };
}

describe('Claude tool Hook attribution', () => {
    it('routes a tool Hook to the subagent whose call of that tool is still running', () => {
        const { applyTask, routing } = feedback();
        routing.observeToolUses([{ type: 'tool_use', id: 'main-bash', name: 'Bash' }]);
        routing.observeToolUses([{ type: 'tool_use', id: 'child-read', name: 'Read' }], 'task-a');
        expect(routing.onMessage(hook('PreToolUse:Read'))).toBe(true);
        expect(applyTask.mock.calls).toMatchObject([
            [
                'task-a',
                [
                    {
                        item: {
                            heading: {
                                kind: 'hook',
                                outcome: 'failed',
                                hook: 'PreToolUse:Read',
                                exitCode: 2,
                            },
                        },
                    },
                ],
            ],
        ]);
    });

    it('keeps a tool Hook matched to the main Agent in the main timeline, labeled as that Agent’s', () => {
        const { applyTask, routing } = feedback();
        routing.observeToolUses([{ type: 'tool_use', id: 'child-read', name: 'Read' }], 'task-a');
        routing.observeToolResults([{ type: 'tool_result', tool_use_id: 'child-read' }]);
        routing.observeToolUses([{ type: 'tool_use', id: 'main-read', name: 'Read' }]);
        expect(routing.onMessage(hook('PreToolUse:Read'))).toBe(false);
        expect(applyTask).not.toHaveBeenCalled();
        expect(routing.toolHookOwner(hook('PreToolUse:Read'))).toBe('main');
    });

    it('attributes a Post Hook to a call that just settled, but not to one long finished', () => {
        const { routing, advance } = feedback();
        routing.observeToolUses([{ type: 'tool_use', id: 'child-edit', name: 'Edit' }], 'task-a');
        routing.observeToolResults([{ type: 'tool_result', tool_use_id: 'child-edit' }]);
        expect(routing.toolHookOwner(hook('PostToolUse:Edit'))).toEqual({ taskId: 'task-a' });
        advance(60_000);
        expect(routing.toolHookOwner(hook('PostToolUse:Edit'))).toBeUndefined();
    });

    it('never guesses an owner for a session lifecycle Hook', () => {
        const { routing } = feedback();
        routing.observeToolUses([{ type: 'tool_use', id: 'child-read', name: 'Read' }], 'task-a');
        expect(routing.toolHookOwner(hook('Stop'))).toBeUndefined();
        expect(routing.toolHookOwner(hook('UserPromptSubmit'))).toBeUndefined();
    });
});
