import type { HookCallback, HookCallbackMatcher, HookEvent } from '@anthropic-ai/claude-agent-sdk';

import { commandCreatesWorktree, isOpaqueAgentSessionId } from '../agents';
import { isRecord } from './chat-items';
import type { AgentChatSessionHost } from './chat-provider';
import { withTimeout } from './claude-prompt-queue';
import { withClaudeWorktreeHooks } from './worktree/enter-worktree-hooks';

type ClaudeHooks = Partial<Record<HookEvent, HookCallbackMatcher[]>>;
type ShellPhase = 'shellToolFailed' | 'shellToolFinished' | 'shellToolStarted';

/**
 * Matches the Terminal bridge's socket budget, so a slow Git read holds a Chat's Bash no longer than a Terminal's.
 */
const SHELL_HOOK_DELIVERY_TIMEOUT_MS = 2_000;

const SHELL_HOOK_PHASES = {
    PreToolUse: 'shellToolStarted',
    PostToolUse: 'shellToolFinished',
    PostToolUseFailure: 'shellToolFailed',
} as const satisfies Partial<Record<HookEvent, ShellPhase>>;

/**
 * The Chat counterpart of the Terminal hook bridge's Bash classification. A Terminal Agent reports `shellTool*` phases
 * through `bridge.cjs`; a Chat runs Claude Code through the Agent SDK, so these in-process callbacks synthesize the
 * same signals from the same classifier. Without them a Chat never follows the worktree its Agent creates.
 *
 * Only the classification and the opaque tool id leave the callback; the command and its output do not. PreToolUse
 * awaits delivery (bounded like the bridge) so the before-snapshot of a `git worktree add` is captured while Claude
 * Code still holds the tool back.
 *
 * The hook's `cwd` is deliberately not reported as `agentCwd`. A Chat locates its transcript through
 * `agentProviderStateRoot`, and a Bash `cd` into a worktree root moves the hook cwd without moving the transcript, so a
 * persisted divergence would make the Chat unable to resume. `EnterWorktree` and `ExitWorktree` are the exception and
 * are added here from `worktree/enter-worktree-hooks.ts`, because they move the transcript with the directory.
 */
export function withClaudeShellHooks(
    hooks: ClaudeHooks,
    observe: AgentChatSessionHost['observeLifecycle'],
): ClaudeHooks {
    const base = withClaudeWorktreeHooks(hooks, observe);
    const merged: ClaudeHooks = { ...base };
    for (const [event, phase] of Object.entries(SHELL_HOOK_PHASES) as Array<
        [keyof typeof SHELL_HOOK_PHASES, ShellPhase]
    >)
        merged[event] = [
            ...(base[event] ?? []),
            { matcher: '^Bash$', hooks: [shellHook(phase, observe)] },
        ];
    return merged;
}

function shellHook(
    phase: ShellPhase,
    observe: AgentChatSessionHost['observeLifecycle'],
): HookCallback {
    return async (input) => {
        if (
            (input.hook_event_name !== 'PreToolUse' &&
                input.hook_event_name !== 'PostToolUse' &&
                input.hook_event_name !== 'PostToolUseFailure') ||
            input.tool_name !== 'Bash'
        )
            return {};
        const command = isRecord(input.tool_input) ? input.tool_input.command : undefined;
        const toolUseId = input.tool_use_id;
        // Like the bridge, a Bash that cannot create a worktree carries no pairing identity; its outcome still drives
        // the deletion revalidation of a followed worktree.
        const createsWorktree =
            commandCreatesWorktree(command) &&
            toolUseId.length <= 256 &&
            isOpaqueAgentSessionId(toolUseId);
        try {
            await withTimeout(
                observe({
                    phase,
                    ...(createsWorktree && {
                        agentToolUseId: toolUseId,
                        worktreeCreateIntent: true,
                    }),
                }),
                SHELL_HOOK_DELIVERY_TIMEOUT_MS,
            );
        } catch {
            // A late snapshot records nothing, so the outcome cannot be attributed; the tool proceeds either way.
        }
        return {};
    };
}
