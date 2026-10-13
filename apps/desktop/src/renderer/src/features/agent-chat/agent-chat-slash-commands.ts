import type { AgentAction, AgentChatCommand } from '@caxri/protocol';
import { AGENT_CHAT_GOAL_COMMAND, agentChatSlashQuery } from '@caxri/protocol';

import { translate } from '../../i18n';
import { searchAgentActions } from '../agent-actions/agent-action-search';

/**
 * The Desktop Chat composer's slash-command and skill menu. Runnable commands are the provider's own
 * (`AgentChatSnapshot.commands`); reading a draft as a command is shared with the phone (`parseAgentChatCommand`).
 */

const MAX_SUGGESTIONS = 50;

/**
 * What the composer menu offers: the provider's runnable Chat commands, then the skills the Agent Commands & Skills
 * picker (`Command+Shift+A`) discovers for this Terminal, after the user's Settings overrides. Picker commands are left
 * out because a Chat runs only what its provider reported, and a skill the provider already lists as a command keeps
 * the runnable command row.
 */
export function agentChatMenuActions(
    commands: readonly AgentChatCommand[] | undefined,
    discovered: readonly AgentAction[] | undefined,
): AgentAction[] {
    const runnable = (commands ?? []).map((command): AgentAction => ({
        invocation: `/${command.name}`,
        kind: 'command',
        ...(command.description && { description: command.description }),
        ...(command.argumentHint && { argumentHint: command.argumentHint }),
        requiresArguments: Boolean(command.argumentHint),
        source: 'builtIn',
    }));
    const invocations = new Set(runnable.map((action) => action.invocation));
    const skills = (discovered ?? []).filter(
        (action) => action.kind === 'skill' && !invocations.has(action.invocation),
    );
    return [...runnable, ...skills];
}

/**
 * Menu rows matching `query`, ranked like the Agent Commands & Skills picker, then grouped: the provider's commands
 * under `Commands`, the discovered skills under `Skills`, each group keeping its rank order. The sigil the user typed
 * picks the leading group: `/` leads with commands and `$` with skills, so `$rev` never opens on a command that only
 * matched its description. The arrow keys walk this order, so it has to be the order the rows are drawn in.
 */
export function filterAgentChatActions(
    actions: readonly AgentAction[],
    query: string,
    sigil: '/' | '$' = '/',
): AgentAction[] {
    const ranked = searchAgentActions(actions, query).slice(0, MAX_SUGGESTIONS);
    const commands = ranked.filter((action) => action.kind === 'command');
    const skills = ranked.filter((action) => action.kind !== 'command');
    return sigil === '$' ? [...skills, ...commands] : [...commands, ...skills];
}

/**
 * The menu rows for a draft: none unless it is a bare invocation (`agentChatSlashQuery`), otherwise the matches led by
 * the group its sigil names (`filterAgentChatActions`).
 */
export function agentChatDraftMatches(
    actions: readonly AgentAction[],
    draft: string,
): AgentAction[] {
    const query = agentChatSlashQuery(draft);
    if (query === undefined) return [];
    return filterAgentChatActions(actions, query, draft.startsWith('$') ? '$' : '/');
}

/**
 * The group heading a row starts, or `undefined` when it continues the group above it. An identity, not display text:
 * the menu translates it.
 */
export function agentChatMenuGroupHeading(
    actions: readonly AgentAction[],
    index: number,
): 'Commands' | 'Skills' | undefined {
    const group = (action: AgentAction | undefined) =>
        action === undefined ? undefined : action.kind === 'command' ? 'Commands' : 'Skills';
    const current = group(actions[index]);
    return current === group(actions[index - 1]) ? undefined : current;
}

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
 * The draft after choosing a row. A command that takes arguments, and every skill, leaves the cursor after a space for
 * what to ask; a command without arguments runs straight away, so the draft is just its name. A Codex `$skill` is sent
 * as ordinary text, which Codex resolves to the skill the same way its own composer does.
 */
export function completeAgentChatAction(action: AgentAction): string {
    return action.kind === 'command' && !action.argumentHint
        ? action.invocation
        : `${action.invocation} `;
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
