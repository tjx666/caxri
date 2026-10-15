import { z } from 'zod';

import type { AgentAction } from './agent-action-contract.js';
import { searchAgentActions } from './agent-action-search.js';

export const MAX_AGENT_CHAT_COMMANDS = 200;

/**
 * A slash command the provider runs. The list is the provider's own (Claude Code reports its commands, Codex has a
 * fixed set Caxri maps to app-server methods), so a command that is not listed is never offered.
 */
export const agentChatCommandSchema = z.strictObject({
    name: z
        .string()
        .min(1)
        .max(100)
        .regex(/^[\w:.-]+$/u),
    description: z.string().max(500).optional(),
    /**
     * Placeholder for the command's arguments, such as `<file>`. A command without one runs as soon as it is chosen.
     */
    argumentHint: z.string().max(200).optional(),
    /**
     * Marks the provider's native goal command (Codex's `/goal`), which the composer's Goal mode drives. A same-named
     * custom command, such as a Claude Code `/goal` skill, carries no mark and runs like any other command.
     */
    goal: z.literal(true).optional(),
});

export type AgentChatCommand = z.infer<typeof agentChatCommandSchema>;

/**
 * How every Chat composer (Desktop and the phone) reads a draft against the provider's runnable commands
 * (`AgentChatSnapshot.commands`), so no composer runs a command the provider did not report.
 */

/**
 * The name being typed while the draft is still a bare `/name` or `$name` with nothing after it; `undefined` once the
 * user has typed a space or anything that is not an invocation. Desktop searches commands and skills alike under either
 * prefix, so a user does not need to know which one the provider spells with `$`. The phone reads the same query.
 */
export function agentChatSlashQuery(draft: string): string | undefined {
    return /^[/$]([\w:.-]*)$/u.exec(draft)?.[1];
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
 * Most rows any Chat composer menu ranks before grouping; a surface may draw fewer.
 */
const MAX_AGENT_CHAT_MENU_SUGGESTIONS = 50;

/**
 * What a Chat composer menu offers: the provider's runnable Chat commands, then the skills Agent action discovery
 * (`agentActions.list`, or `mobile.agent.actions` on the phone) finds for this Terminal. Discovered commands are left
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
 * Menu rows matching `query`, ranked like the Agent Commands & Skills picker (`searchAgentActions` matches names,
 * invocations, and descriptions), then grouped: the provider's commands under `Commands`, the discovered skills under
 * `Skills`, each group keeping its rank order. The sigil the user typed picks the leading group: `/` leads with
 * commands and `$` with skills, so `$rev` never opens on a command that only matched its description. Keyboard
 * navigation walks this order, so it has to be the order the rows are drawn in.
 */
export function filterAgentChatActions(
    actions: readonly AgentAction[],
    query: string,
    sigil: '/' | '$' = '/',
): AgentAction[] {
    const ranked = searchAgentActions(actions, query).slice(0, MAX_AGENT_CHAT_MENU_SUGGESTIONS);
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
 * each surface translates it.
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
 * The draft after choosing a row. A command that takes arguments, and every skill, leaves the cursor after a space for
 * what to ask; a command without arguments runs straight away, so the draft is just its name. A Codex `$skill` is sent
 * as ordinary text, which Codex resolves to the skill the same way its own composer does.
 */
export function completeAgentChatAction(action: AgentAction): string {
    return action.kind === 'command' && !action.argumentHint
        ? action.invocation
        : `${action.invocation} `;
}
