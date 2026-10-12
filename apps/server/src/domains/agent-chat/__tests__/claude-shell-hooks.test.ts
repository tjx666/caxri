import type { HookCallbackMatcher, HookInput } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import type { AgentCoordinator, AgentLifecycleSignal } from '../../agents/index';
import { fixture } from '../../workbench/__tests__/roots.fixture';
import { handleAgentLifecycleSignal } from '../../workbench/index';
import { chatLifecycleHost } from '../chat-launch';
import type { ChatLifecycleEvent } from '../chat-provider';
import { withClaudeShellHooks } from '../claude-shell-hooks';

type HookEventName = 'PostToolUse' | 'PostToolUseFailure' | 'PreToolUse';

function hookInput(
    event: HookEventName,
    command: string,
    options: { toolName?: string; toolUseId?: string } = {},
): HookInput {
    return {
        hook_event_name: event,
        session_id: 'session-1',
        transcript_path: '/transcripts/session-1.jsonl',
        cwd: '/repo',
        tool_name: options.toolName ?? 'Bash',
        tool_input: { command },
        tool_use_id: options.toolUseId ?? 'toolu_1',
        ...(event === 'PostToolUse' && { tool_response: {} }),
        ...(event === 'PostToolUseFailure' && { error: 'exit 1' }),
    } as HookInput;
}

function shellMatcher(
    hooks: ReturnType<typeof withClaudeShellHooks>,
    event: HookEventName,
): HookCallbackMatcher {
    const matcher = hooks[event]?.at(-1);
    expect(matcher?.matcher).toBe('^Bash$');
    return matcher!;
}

async function run(
    hooks: ReturnType<typeof withClaudeShellHooks>,
    event: HookEventName,
    input: HookInput,
): Promise<void> {
    await expect(
        shellMatcher(hooks, event).hooks[0](input, 'toolu_1', {
            signal: new AbortController().signal,
        }),
    ).resolves.toEqual({});
}

function recordingHooks(events: ChatLifecycleEvent[]) {
    return withClaudeShellHooks({}, (event) => {
        events.push(event);
        return Promise.resolve();
    });
}

describe('withClaudeShellHooks', () => {
    it('reports a worktree-creating Bash command with its tool id and no cwd', async () => {
        const events: ChatLifecycleEvent[] = [];
        const hooks = recordingHooks(events);
        const command = "git -C '/repo' worktree add -b fix/x '/repo-worktrees/fix-x' origin/main";

        await run(hooks, 'PreToolUse', hookInput('PreToolUse', command));
        await run(hooks, 'PostToolUse', hookInput('PostToolUse', command));
        await run(hooks, 'PostToolUseFailure', hookInput('PostToolUseFailure', command));

        expect(events).toEqual(
            (['shellToolStarted', 'shellToolFinished', 'shellToolFailed'] as const).map(
                (phase) => ({ phase, agentToolUseId: 'toolu_1', worktreeCreateIntent: true }),
            ),
        );
    });

    it('carries no pairing identity for other commands or an unsafe tool id', async () => {
        const events: ChatLifecycleEvent[] = [];
        const hooks = recordingHooks(events);

        await run(hooks, 'PreToolUse', hookInput('PreToolUse', 'git status'));
        await run(
            hooks,
            'PreToolUse',
            hookInput('PreToolUse', 'git worktree add ../x', { toolUseId: '../escape' }),
        );
        await run(hooks, 'PreToolUse', hookInput('PreToolUse', 'git status', { toolName: 'Read' }));

        expect(events).toEqual([{ phase: 'shellToolStarted' }, { phase: 'shellToolStarted' }]);
    });

    it('keeps the existing hook matchers of every event', () => {
        const effort: HookCallbackMatcher = { hooks: [() => Promise.resolve({})] };
        const hooks = withClaudeShellHooks({ PreToolUse: [effort], Stop: [effort] }, () =>
            Promise.resolve(),
        );

        expect(hooks.PreToolUse).toHaveLength(2);
        expect(hooks.PreToolUse?.[0]).toBe(effort);
        expect(hooks.Stop).toEqual([effort]);
        expect(hooks.PostToolUse).toHaveLength(1);
        expect(hooks.PostToolUseFailure).toHaveLength(1);
    });

    it('holds PreToolUse until the lifecycle path has handled the event', async () => {
        const delivered = Promise.withResolvers<void>();
        const hooks = withClaudeShellHooks({}, () => delivered.promise);
        let isSettled = false;
        const pending = (async () => {
            await run(hooks, 'PreToolUse', hookInput('PreToolUse', 'git worktree add ../x'));
            isSettled = true;
        })();

        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(isSettled).toBe(false);
        delivered.resolve();
        await pending;
        expect(isSettled).toBe(true);
    });

    it('releases PreToolUse after the bridge budget when delivery stalls', async () => {
        vi.useFakeTimers();
        try {
            const hooks = withClaudeShellHooks({}, () => new Promise<void>(() => {}));
            const pending = run(
                hooks,
                'PreToolUse',
                hookInput('PreToolUse', 'git worktree add ../x'),
            );
            await vi.advanceTimersByTimeAsync(2_000);
            await pending;
        } finally {
            vi.useRealTimers();
        }
    });

    it('drops events from a superseded Chat launch', async () => {
        const observeLifecycleSignal = vi.fn(() => Promise.resolve());
        let isCurrent = true;
        const host = chatLifecycleHost(
            { logger: { write: vi.fn() } as never, observeLifecycleSignal },
            {
                launchId: 'chat-launch',
                provider: 'claude',
                terminalId: 'terminal-1',
                isCurrent: () => isCurrent,
                onEvent: () => {},
            },
        );

        await host.observeLifecycle({ phase: 'shellToolStarted' });
        isCurrent = false;
        await host.observeLifecycle({ phase: 'shellToolStarted' });

        expect(observeLifecycleSignal).toHaveBeenCalledTimes(1);
        expect(observeLifecycleSignal).toHaveBeenCalledWith({
            phase: 'shellToolStarted',
            launchId: 'chat-launch',
            provider: 'claude',
            terminalId: 'terminal-1',
        });
    });

    /**
     * The reported regression: a Claude Chat ran `git worktree add` and the Session's Workbench Root stayed on `main`,
     * because a Chat never produced the `shellTool*` signals the Terminal hook bridge does.
     */
    it('lets a Chat Session follow the worktree its Agent created', async () => {
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
                    handleAgentLifecycleSignal(coordinator, context.service, signal),
            },
            {
                launchId: 'chat-launch',
                provider: 'claude',
                terminalId: chat.id,
                isCurrent: () => true,
                onEvent: () => {},
            },
        );
        const hooks = withClaudeShellHooks({}, host.observeLifecycle);
        const command = `git worktree add -b feature/chat '${context.worktreeRoot}'`;

        await run(hooks, 'PreToolUse', hookInput('PreToolUse', command));
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/chat', rootPath: context.worktreeRoot },
        ]);
        await run(hooks, 'PostToolUse', hookInput('PostToolUse', command));

        await vi.waitFor(() =>
            expect(context.database.getSession(session.id)).toMatchObject({
                rootPath: context.worktreeRoot,
            }),
        );
        // The Chat's transcript root stays its launch root.
        expect(context.database.getTerminal(chat.id)?.agentCwd).toBeUndefined();
        await context.service.close();
        context.database.close();
    });
});
