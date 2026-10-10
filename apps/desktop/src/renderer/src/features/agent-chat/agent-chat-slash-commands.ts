import type { AgentAction, AgentChatCommand } from '@caxri/protocol';

import { searchAgentActions } from '../agent-actions/agent-action-search';

/**
 * Slash-command and skill parsing for the Chat composer. Runnable commands are the provider's own
 * (`AgentChatSnapshot.commands`), so the composer never runs a command the provider did not report.
 */

const MAX_SUGGESTIONS = 50;

/**
 * The name being typed while the draft is still a bare `/name` or `$name` with nothing after it; `undefined` once the
 * user has typed a space or anything that is not an invocation. Either prefix searches commands and skills alike, so a
 * user does not need to know which one the provider spells with `$`.
 */
export function agentChatSlashQuery(draft: string): string | undefined {
    return /^[/$]([\w:.-]*)$/u.exec(draft)?.[1];
}

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
 * Menu rows matching `query`, ranked like the Agent Commands & Skills picker.
 */
export function filterAgentChatActions(
    actions: readonly AgentAction[],
    query: string,
): AgentAction[] {
    return searchAgentActions(actions, query).slice(0, MAX_SUGGESTIONS);
}

/**
 * The command a submitted draft runs: `/name` or `/name arguments` where `name` is listed. Any other draft, including
 * an unknown `/word`, is sent as an ordinary message.
 */
export function parseAgentChatCommand(
    draft: string,
    commands: readonly AgentChatCommand[] | undefined,
): { name: string; arguments?: string } | undefined {
    const match = /^\/([\w:.-]+)(?:\s([\s\S]*))?$/u.exec(draft.trim());
    if (!match || !commands?.some((command) => command.name === match[1])) return undefined;
    const arguments_ = match[2]?.trim();
    return { name: match[1], ...(arguments_ && { arguments: arguments_ }) };
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
 * DOM id of a suggestion row, for the input's `aria-activedescendant`.
 */
export function agentChatCommandOptionId(listId: string, invocation: string): string {
    return `${listId}-${invocation}`;
}
