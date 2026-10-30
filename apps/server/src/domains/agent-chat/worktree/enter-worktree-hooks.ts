import type { HookCallback, HookCallbackMatcher, HookEvent } from '@anthropic-ai/claude-agent-sdk';

import { isRecord } from '../chat-items';
import type { AgentChatSessionHost } from '../chat-provider';
import { withTimeout } from '../providers/claude/prompt-queue';

type ClaudeHooks = Partial<Record<HookEvent, HookCallbackMatcher[]>>;

/**
 * Bounded like the shell hooks: the reconciliation only needs to land before the next tool or read, and a slow Git read
 * must not hold the Agent's tool result back for longer than a Terminal's hook would.
 */
const WORKTREE_HOOK_DELIVERY_TIMEOUT_MS = 2_000;

const MAX_AGENT_CWD_LENGTH = 1_024;

/**
 * The `tool_response` field that names the directory Claude Code is in after the tool ran, per the SDK's
 * `EnterWorktreeOutput` (`worktreePath`) and `ExitWorktreeOutput` (`originalCwd`).
 */
const WORKTREE_TOOLS = {
    EnterWorktree: 'worktreePath',
    ExitWorktree: 'originalCwd',
} as const;

/**
 * Reports the directory Claude Code moved itself to with its built-in `EnterWorktree` and `ExitWorktree` tools, so a
 * Chat follows that worktree under `workbench.newWorktreeBehavior` like a Terminal does (issue caxri#1848).
 *
 * Neither tool goes through Bash, so the Bash hooks never see them, and `EnterWorktree` in `path` mode creates no new
 * worktree for the topology delta to attribute. The hook reports `agentCwd` on a `shellToolFinished` event, which the
 * lifecycle path routes to the Workbench Root service without touching Agent status. That service proves the claim
 * against the owning Project's Git worktree topology before anything becomes durable, so a path outside the Project's
 * worktrees is ignored. Because Claude Code moves the transcript into the worktree's provider directory, the persisted
 * `agentCwd` is also what lets a restarted Chat find its conversation again.
 *
 * Only these two tools report it. A Bash `cd` moves the hook `cwd` without moving the transcript, so the hook `cwd` is
 * never used. A subagent's call (`agent_id` set) moves only that subagent, not the Session's Agent, and is ignored.
 */
export function withClaudeWorktreeHooks(
    hooks: ClaudeHooks,
    observe: AgentChatSessionHost['observeLifecycle'],
): ClaudeHooks {
    return {
        ...hooks,
        PostToolUse: [
            ...(hooks.PostToolUse ?? []),
            { matcher: '^(EnterWorktree|ExitWorktree)$', hooks: [worktreeHook(observe)] },
        ],
    };
}

function worktreeHook(observe: AgentChatSessionHost['observeLifecycle']): HookCallback {
    return async (input) => {
        if (input.hook_event_name !== 'PostToolUse' || input.agent_id) return {};
        const field = input.tool_name in WORKTREE_TOOLS ? WORKTREE_TOOLS : undefined;
        const key = field?.[input.tool_name as keyof typeof WORKTREE_TOOLS];
        const reported =
            key && isRecord(input.tool_response) ? input.tool_response[key] : undefined;
        if (
            typeof reported !== 'string' ||
            reported.length === 0 ||
            reported.length > MAX_AGENT_CWD_LENGTH ||
            !reported.startsWith('/') ||
            reported.includes('\0')
        )
            return {};
        try {
            await withTimeout(
                observe({ phase: 'shellToolFinished', agentCwd: reported }),
                WORKTREE_HOOK_DELIVERY_TIMEOUT_MS,
            );
        } catch {
            // The tool already succeeded; a late reconciliation still lands, and the next divergent report retries.
        }
        return {};
    };
}
