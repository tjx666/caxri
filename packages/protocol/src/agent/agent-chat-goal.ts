import type { AgentChatGoal } from './agent-chat-goal-contract.js';

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
 * CLI.
 */
export function agentChatGoalToggle(goal: AgentChatGoal): 'pause' | 'resume' | undefined {
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
 * How long a goal has been worked on, as the Codex app shows it: `45s`, `12m 5s`, `1h 37m 29s`. Unlike a turn's
 * duration, a goal runs for hours, so the hours are spelled out instead of reading `97m`.
 */
export function formatAgentChatGoalDuration(seconds: number): string {
    const total = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const rest = total % 60;
    if (hours > 0) return `${hours}h ${minutes}m ${rest}s`;
    if (minutes > 0) return `${minutes}m ${rest}s`;
    return `${rest}s`;
}
