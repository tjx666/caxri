import type { AgentAction, AgentChatCommand } from '@caxri/protocol';
import { AGENT_CHAT_GOAL_COMMAND } from '@caxri/protocol';

import { translate } from '../../i18n';

/**
 * The Desktop Chat composer's slash-command and skill menu helpers that are Desktop-only. Runnable commands are the
 * provider's own (`AgentChatSnapshot.commands`); the menu rows, their ranking and grouping, and reading a draft as a
 * command are shared with the phone (`agentChatMenuActions`, `agentChatDraftMatches`, `parseAgentChatCommand`).
 */

/**
 * The menu's status line for skills, or `undefined` when discovery has answered: skills are discovered only from a
 * running Agent, and the first discovery takes a moment.
 */
export function agentChatSkillDiscoveryNotice(state: {
    isAgentRunning: boolean;
    isLoading: boolean;
}): { text: string; isLoading: boolean } | undefined {
    if (!state.isAgentRunning)
        return { text: translate('agentChat.slash.skillsNeedAgent'), isLoading: false };
    return state.isLoading
        ? { text: translate('agentChat.slash.loadingSkills'), isLoading: true }
        : undefined;
}

/**
 * The `/name` or `$name` a sent message starts with, the only place the composer puts an invocation, split from what
 * follows it. A name starts with a letter, so `$5` or a path such as `/usr/bin` stays plain text.
 */
export function agentChatLeadingInvocation(
    text: string,
): { invocation: string; rest: string } | undefined {
    const match = /^([/$][A-Za-z][\w:.-]*)(?=\s|$)/u.exec(text);
    const invocation = match?.[1];
    return invocation ? { invocation, rest: text.slice(invocation.length) } : undefined;
}

/**
 * Whether the provider has a native goal command (Codex's `/goal`), which the composer's Goal mode and Add menu Goal
 * need. A custom command that only shares the name is not one.
 */
export function isAgentChatGoalOffered(commands: readonly AgentChatCommand[] | undefined): boolean {
    return (
        commands?.some(
            (command) => command.goal === true && command.name === AGENT_CHAT_GOAL_COMMAND,
        ) === true
    );
}

/**
 * Whether choosing `action` from the slash menu enters Goal mode instead of completing `/goal ` in the draft, as the
 * Codex app's `/goal` does.
 */
export function isAgentChatGoalAction(action: AgentAction): boolean {
    return action.kind === 'command' && action.invocation === `/${AGENT_CHAT_GOAL_COMMAND}`;
}

/**
 * The draft once Goal mode takes it: what is typed becomes the goal's text, so a leading `/goal` the user already typed
 * is dropped rather than becoming part of the objective.
 */
export function agentChatGoalModeDraft(draft: string): string {
    const match = new RegExp(String.raw`^\s*/${AGENT_CHAT_GOAL_COMMAND}(?:\s+|$)`, 'u').exec(draft);
    return match ? draft.slice(match[0].length) : draft;
}
