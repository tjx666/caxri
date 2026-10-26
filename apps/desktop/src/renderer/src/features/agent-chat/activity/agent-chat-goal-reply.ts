import type { AgentChatItem } from '@caxri/protocol';

type Notice = Extract<AgentChatItem, { type: 'notice' }>;

/**
 * A Claude Code `/goal` reply, read back into what happened to the goal so the transcript can show it as a goal event
 * instead of raw command output.
 */
export interface AgentChatGoalReply {
    action: 'set' | 'cleared' | 'active' | 'none';
    /**
     * The goal's condition as the user wrote it; empty for `none`.
     */
    objective: string;
    /**
     * Provider detail after the condition, such as the progress and the last check of an active goal.
     */
    detail?: string;
}

/**
 * The title Server Core gives a built-in `/goal` command's output (`claude-feedback.ts`). A plugin's same-named command
 * carries a `plugin · /goal` title and stays plain output.
 */
const GOAL_COMMAND_TITLE = '/goal';

const PREFIXES = [
    ['Goal set: ', 'set'],
    ['Goal cleared: ', 'cleared'],
    ['Goal active: ', 'active'],
] as const;

/**
 * Reads the replies Claude Code's `/goal` prints (verified with Claude Code 2.1.310): `Goal set: <condition>`, `Goal
 * cleared: <condition>`, `No goal set`, and `Goal active: <condition> (<progress>)` optionally followed by a `Last
 * check:` line. Anything else, such as the usage hint or the length error, returns `undefined` and keeps the plain
 * command output, since only these replies say what the goal now is.
 */
export function parseAgentChatGoalReply(item: Notice): AgentChatGoalReply | undefined {
    if (item.kind !== 'output' || item.title !== GOAL_COMMAND_TITLE) return undefined;
    const text = item.message?.trim() ?? '';
    if (text === 'No goal set') return { action: 'none', objective: '' };
    for (const [prefix, action] of PREFIXES) {
        if (!text.startsWith(prefix)) continue;
        const body = text.slice(prefix.length);
        if (action !== 'active') return { action, objective: body.trim() };
        const [first = '', ...rest] = body.split('\n');
        const progress = /^(.*\S)\s+\(([^()]*)\)$/.exec(first);
        const detail = [progress?.[2], ...rest]
            .map((line) => line?.trim())
            .filter(Boolean)
            .join('\n');
        return {
            action,
            objective: (progress?.[1] ?? first).trim(),
            ...(detail && { detail }),
        };
    }
    return undefined;
}
