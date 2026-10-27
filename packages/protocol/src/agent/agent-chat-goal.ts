import type { AgentChatItem } from './agent-chat-contract.js';
import type { AgentChatGoal } from './agent-chat-goal-contract.js';
import type { AgentChatLabelTranslate } from './agent-chat-labels.js';
import { translateAgentChatLabel } from './agent-chat-labels.js';

/**
 * The command a provider with native goals lists (Codex's `/goal`). Every Client runs goal changes through it, so the
 * composer, the goal row's buttons, and the phone share one path into Server Core.
 */
export const AGENT_CHAT_GOAL_COMMAND = 'goal';

/**
 * What a `/goal` command asks for. `set` replaces any goal that is not complete with a new one.
 */
export type AgentChatGoalChange =
    | { action: 'set'; objective: string }
    | { action: 'pause' }
    | { action: 'resume' }
    | { action: 'clear' };

const GOAL_KEYWORDS = new Set(['pause', 'resume', 'clear']);

/**
 * Reads `/goal` arguments the way the Codex CLI does: `pause`, `resume`, or `clear` on their own act on the current
 * goal, and anything else is a new objective. Bare `/goal` asks for nothing and returns `undefined`.
 */
export function parseAgentChatGoalArguments(
    arguments_: string | undefined,
): AgentChatGoalChange | undefined {
    const text = arguments_?.trim();
    if (!text) return undefined;
    const keyword = text.toLowerCase();
    if (GOAL_KEYWORDS.has(keyword)) return { action: keyword as 'pause' | 'resume' | 'clear' };
    return { action: 'set', objective: text };
}

/**
 * The `/goal` arguments that perform `change`, for a Client that sends it as a command.
 */
export function agentChatGoalArguments(change: AgentChatGoalChange): string {
    return change.action === 'set' ? change.objective : change.action;
}

/**
 * Which of pause and resume the goal offers. An active goal can pause; one the user paused, the provider gave up on, or
 * a usage limit stopped can resume. A goal that reached its budget or completed can only be cleared, as in the Codex
 * CLI, and so can every goal of a provider without pause.
 */
export function agentChatGoalToggle(goal: AgentChatGoal): 'pause' | 'resume' | undefined {
    if (goal.pausable === false) return undefined;
    switch (goal.status) {
        case 'active': {
            return 'pause';
        }
        case 'paused':
        case 'blocked':
        case 'usageLimited': {
            return 'resume';
        }
        default: {
            return undefined;
        }
    }
}

/**
 * Seconds the goal has been worked on at `now`. The provider counts time only while a turn works on an active goal and
 * reports it at turn boundaries, so a running turn adds the time since the later of its start and the last report.
 */
export function agentChatGoalElapsedSeconds(
    goal: AgentChatGoal,
    now: number,
    runningTurnStartedAt: number | undefined,
): number {
    if (runningTurnStartedAt === undefined || goal.status !== 'active') return goal.timeUsedSeconds;
    const since = Math.max(goal.updatedAt, runningTurnStartedAt);
    return goal.timeUsedSeconds + Math.max(0, now - since) / 1000;
}

/**
 * A goal's time split into the figures it is written with: hours, minutes, and seconds, the larger units only once they
 * are reached.
 */
export function agentChatGoalDurationParts(seconds: number): {
    hours: number;
    minutes: number;
    seconds: number;
} {
    const total = Math.max(0, Math.floor(seconds));
    return {
        hours: Math.floor(total / 3600),
        minutes: Math.floor((total % 3600) / 60),
        seconds: total % 60,
    };
}

/**
 * How long a goal has been worked on, as the Codex app shows it: `45s`, `12m 5s`, `1h 37m 29s` (`1 小时 37 分 29 秒` in
 * Chinese). Unlike a turn's duration, a goal runs for hours, so the hours are spelled out instead of reading `97m`.
 */
export function formatAgentChatGoalDuration(
    seconds: number,
    t: AgentChatLabelTranslate = translateAgentChatLabel,
): string {
    const parts = agentChatGoalDurationParts(seconds);
    if (parts.hours > 0) return t('agentChat.fold.durationHoursMinutesSeconds', parts);
    if (parts.minutes > 0) return t('agentChat.fold.durationMinutesSeconds', parts);
    return t('agentChat.fold.durationSeconds', parts);
}

type Notice = Extract<AgentChatItem, { type: 'notice' }>;

/**
 * A Claude Code `/goal` reply, read back into what happened to the goal: the transcript shows it as a goal event
 * instead of raw command output, and Server Core keeps the snapshot's goal from it, since Claude Code reports no goal
 * state.
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
export const AGENT_CHAT_GOAL_COMMAND_TITLE = '/goal';

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
    if (item.kind !== 'output' || item.title !== AGENT_CHAT_GOAL_COMMAND_TITLE) return undefined;
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
