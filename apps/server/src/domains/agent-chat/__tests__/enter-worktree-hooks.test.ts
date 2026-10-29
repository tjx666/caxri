import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import type { AgentCoordinator, AgentLifecycleSignal } from '../../agents/index';
import { fixture } from '../../workbench/__tests__/roots.fixture';
import { handleAgentLifecycleSignal } from '../../workbench/index';
import { chatLifecycleHost } from '../chat-launch';
import type { ChatLifecycleEvent } from '../chat-provider';
import { withClaudeWorktreeHooks } from '../worktree/enter-worktree-hooks';

function postToolUse(
    toolName: string,
    toolResponse: unknown,
    extra: Record<string, unknown> = {},
): HookInput {
    return {
        hook_event_name: 'PostToolUse',
        session_id: 'session-1',
        transcript_path: '/transcripts/session-1.jsonl',
        cwd: '/somewhere/else',
        tool_name: toolName,
        tool_input: {},
        tool_response: toolResponse,
        tool_use_id: 'toolu_1',
        ...extra,
    };
}

async function run(
    hooks: ReturnType<typeof withClaudeWorktreeHooks>,
    input: HookInput,
): Promise<void> {
    const matcher = hooks.PostToolUse?.at(-1);
    expect(matcher?.matcher).toBe('^(EnterWorktree|ExitWorktree)$');
    await expect(
        matcher!.hooks[0](input, 'toolu_1', { signal: new AbortController().signal }),
    ).resolves.toEqual({});
}

function recordingHooks(events: ChatLifecycleEvent[]) {
    return withClaudeWorktreeHooks({}, (event) => {
        events.push(event);
        return Promise.resolve();
    });
}

describe('withClaudeWorktreeHooks', () => {
    it('reports the entered worktree and the directory ExitWorktree returned to, never the hook cwd', async () => {
        const events: ChatLifecycleEvent[] = [];
        const hooks = recordingHooks(events);

        await run(hooks, postToolUse('EnterWorktree', { worktreePath: '/repo-wt/a', message: '' }));
        await run(
            hooks,
            postToolUse('ExitWorktree', {
                action: 'keep',
                originalCwd: '/repo',
                worktreePath: '/repo-wt/a',
            }),
        );

        expect(events).toEqual([
            { phase: 'shellToolFinished', agentCwd: '/repo-wt/a' },
            { phase: 'shellToolFinished', agentCwd: '/repo' },
        ]);
    });

    it('ignores subagent calls, other tools, and malformed responses', async () => {
        const events: ChatLifecycleEvent[] = [];
        const hooks = recordingHooks(events);

        await run(
            hooks,
            postToolUse('EnterWorktree', { worktreePath: '/repo-wt/a' }, { agent_id: 'agent-1' }),
        );
        await run(hooks, postToolUse('Bash', { worktreePath: '/repo-wt/a' }));
        await run(hooks, postToolUse('EnterWorktree', 'Switched to worktree'));
        await run(hooks, postToolUse('EnterWorktree', { worktreePath: 'relative/path' }));
        await run(hooks, postToolUse('EnterWorktree', { worktreePath: '/a\0b' }));
        await run(hooks, postToolUse('EnterWorktree', { worktreePath: `/${'a'.repeat(2_000)}` }));
        await run(hooks, postToolUse('ExitWorktree', { worktreePath: '/repo-wt/a' }));

        expect(events).toEqual([]);
    });

    it('releases the tool after the delivery budget when reconciliation stalls', async () => {
        vi.useFakeTimers();
        try {
            const hooks = withClaudeWorktreeHooks({}, () => new Promise<void>(() => {}));
            const pending = run(
                hooks,
                postToolUse('EnterWorktree', { worktreePath: '/repo-wt/a' }),
            );
            await vi.advanceTimersByTimeAsync(2_000);
            await pending;
        } finally {
            vi.useRealTimers();
        }
    });

    /**
     * The reported gap (issue 1848): a Claude Chat entered an existing worktree with `EnterWorktree`, which no Bash
     * hook sees, so the Session stayed on the owning Project and, once the Agent's transcript moved, could not be
     * resumed.
     */
    it('lets a Chat Session follow EnterWorktree, record the transcript root, and return on ExitWorktree', async () => {
        const context = await fixture();
        context.setBehavior('continueAutomatically');
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/entered', rootPath: context.worktreeRoot },
        ]);
        const { session } = context.sessions[0];
        const chat = context.database.createTerminal(
            session.id,
            'claude',
            context.ownerRoot,
            'chat',
        );
        const coordinator = {
            isCurrentTerminalLaunch: () => true,
            observeLifecycleSignal: () => 'accepted',
        } as unknown as AgentCoordinator;
        const host = chatLifecycleHost(
            {
                logger: { write: vi.fn() } as never,
                observeLifecycleSignal: async (signal: AgentLifecycleSignal) =>
                    handleAgentLifecycleSignal(coordinator, context.service, signal, {
                        settleAgentCwd: true,
                    }),
            },
            {
                launchId: 'chat-launch',
                provider: 'claude',
                terminalId: chat.id,
                isCurrent: () => true,
                onEvent: () => {},
            },
        );
        const hooks = withClaudeWorktreeHooks({}, host.observeLifecycle);

        await run(hooks, postToolUse('EnterWorktree', { worktreePath: context.worktreeRoot }));

        // The hook held the tool result until the reconciliation was durable, so no polling is needed.
        expect(context.database.getTerminal(chat.id)?.agentCwd).toBe(context.worktreeRoot);
        expect(context.database.getSession(session.id)).toMatchObject({
            rootPath: context.worktreeRoot,
        });
        expect(context.database.getTerminal(chat.id)?.cwd).toBe(context.ownerRoot);

        await run(
            hooks,
            postToolUse('ExitWorktree', { action: 'keep', originalCwd: context.ownerRoot }),
        );

        expect(context.database.getTerminal(chat.id)?.agentCwd).toBeUndefined();
        expect(context.database.getSession(session.id)).toMatchObject({
            rootPath: context.ownerRoot,
        });
        await context.service.close();
        context.database.close();
    });

    it('does not follow a path that is not a worktree of the Session Project', async () => {
        const context = await fixture();
        context.setBehavior('continueAutomatically');
        const { session } = context.sessions[0];
        const chat = context.database.createTerminal(
            session.id,
            'claude',
            context.ownerRoot,
            'chat',
        );
        const coordinator = {
            isCurrentTerminalLaunch: () => true,
            observeLifecycleSignal: () => 'accepted',
        } as unknown as AgentCoordinator;
        const host = chatLifecycleHost(
            {
                logger: { write: vi.fn() } as never,
                observeLifecycleSignal: async (signal: AgentLifecycleSignal) =>
                    handleAgentLifecycleSignal(coordinator, context.service, signal, {
                        settleAgentCwd: true,
                    }),
            },
            {
                launchId: 'chat-launch',
                provider: 'claude',
                terminalId: chat.id,
                isCurrent: () => true,
                onEvent: () => {},
            },
        );
        const hooks = withClaudeWorktreeHooks({}, host.observeLifecycle);

        // The default topology lists only the owner, so the directory is outside the Project's worktrees.
        await run(hooks, postToolUse('EnterWorktree', { worktreePath: context.worktreeRoot }));

        expect(context.database.getTerminal(chat.id)?.agentCwd).toBeUndefined();
        expect(context.database.getSession(session.id)).toMatchObject({
            rootPath: context.ownerRoot,
        });
        await context.service.close();
        context.database.close();
    });
});
