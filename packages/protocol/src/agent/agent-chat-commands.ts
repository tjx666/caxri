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
     * Marks the provider's native goal command (Codex's `/goal`, or Claude Code's built-in `/goal`), which the
     * composer's Goal mode drives. A same-named custom command, such as a user's Claude Code `/goal` skill, carries no
     * mark and runs like any other command.
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
 * The rows the menu leads with under `Recent` while nothing follows the sigil yet: the provider's recently used actions
 * (`AgentActionsSettings.recent`, most recent first) that this menu still offers, as Claude Code's own `/` menu puts
 * the user's frequent skills first. Typing a name ranks by the match alone, so the group is empty for any other draft.
 */
export function agentChatRecentMenuActions(
    actions: readonly AgentAction[],
    draft: string,
    recent: readonly string[],
): AgentAction[] {
    if (agentChatSlashQuery(draft) !== '') return [];
    const actionsByInvocation = new Map(actions.map((action) => [action.invocation, action]));
    return recent.flatMap((invocation) => {
        const action = actionsByInvocation.get(invocation);
        return action ? [action] : [];
    });
}

/**
 * The menu rows for a draft: none unless it is a bare invocation (`agentChatSlashQuery`), otherwise the recently used
 * rows (`agentChatRecentMenuActions`) followed by the matches led by the group its sigil names
 * (`filterAgentChatActions`). A recent row is not repeated in its own group.
 */
export function agentChatDraftMatches(
    actions: readonly AgentAction[],
    draft: string,
    recent: readonly string[] = [],
): AgentAction[] {
    const query = agentChatSlashQuery(draft);
    if (query === undefined) return [];
    const leading = agentChatRecentMenuActions(actions, draft, recent);
    const leadingSet = new Set(leading);
    const rest = actions.filter((action) => !leadingSet.has(action));
    return [...leading, ...filterAgentChatActions(rest, query, draft.startsWith('$') ? '$' : '/')];
}

/**
 * The group heading a row starts, or `undefined` when it continues the group above it. The first `recentCount` rows are
 * the `Recent` group (`agentChatRecentMenuActions`). An identity, not display text: each surface translates it.
 */
export function agentChatMenuGroupHeading(
    actions: readonly AgentAction[],
    index: number,
    recentCount = 0,
): 'Commands' | 'Recent' | 'Skills' | undefined {
    const group = (position: number) => {
        if (position < 0 || position >= actions.length) return;
        if (position < recentCount) return 'Recent';
        return actions[position].kind === 'command' ? 'Commands' : 'Skills';
    };
    const current = group(index);
    return current === group(index - 1) ? undefined : current;
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
 * The Chat composer's built-in `/new-session [next task]` command: the user is done with this Session and asks its
 * Agent to hand the next task to an Agent in a new Session of the same Project. Caxri runs it, not the provider, so
 * every provider offers it; the composer sends {@link agentChatSessionHandoffText} as an ordinary message and every
 * Client reads it back with {@link parseAgentChatSessionHandoff} to show a hand-off card instead of the instructions.
 */
export const AGENT_CHAT_SESSION_HANDOFF_COMMAND = 'new-session';

const HEADING = '# Hand off to a new Caxri Session';
const NOTE_HEADING = '## Next task from the user:';

/**
 * The text after `/new-session` when the draft runs the command, `''` for a bare `/new-session`, and `undefined` for
 * any other draft, including `/new-sessions`.
 */
export function parseAgentChatSessionHandoffCommand(draft: string): string | undefined {
    const match = new RegExp(
        String.raw`^\s*/${AGENT_CHAT_SESSION_HANDOFF_COMMAND}(?:\s([\s\S]*))?$`,
        'u',
    ).exec(draft);
    // The optional group is `undefined` at runtime for a bare `/new-session`, despite its `string` type.
    return match ? (match[1] || '').trim() : undefined;
}

/**
 * The message the command sends. The Project and provider are spelled out, so the Agent needs no lookup before it
 * delegates, and the task travels as a brief the Agent writes from the conversation: the next Agent cannot read this
 * one. `--handoff` marks the delegation so the new Session's first message reads as a continuation of this Session. The
 * user's note comes last, under its own heading, where {@link parseAgentChatSessionHandoff} finds it again.
 */
export function agentChatSessionHandoffText({
    note,
    projectId,
    provider,
}: {
    note: string;
    projectId: string;
    provider: string;
}): string {
    return [
        HEADING,
        '',
        'The user is done with this Session and wants the next task to continue in a new Caxri Session that you start now. Do not start the next task here.',
        '',
        "1. Write a self-contained brief for the next Agent to a temporary file. It cannot read this conversation, so include every fact it needs: the next task (the user's note below, or the natural next step of this conversation when the note is empty), the background, the user's decisions and corrections, scope and authorization, the current repository and external state (branches, worktrees, pull requests, issues, running processes), what is already done and must not be redone, and how to verify the result.",
        `2. Run \`"\${CAXRI_CLI:-caxri}" agent delegate create --project ${projectId} --new-session --handoff --title <the task's concrete subject> --provider ${provider} --prompt-file <brief path> --request-id <unique id> --json\`.`,
        "3. Reply with the new Session's title in one or two sentences, then stop. Do not wait for, follow up on, or continue the delegated task.",
        '',
        NOTE_HEADING,
        note.trim(),
    ].join('\n');
}

/**
 * Reads a sent message back as a `/new-session` hand-off: the user's note, `''` when they gave none. `undefined` for
 * any other message. The instructions between the headings may change between versions, so only the headings identify
 * it.
 */
export function parseAgentChatSessionHandoff(text: string): { note: string } | undefined {
    if (!text.startsWith(`${HEADING}\n`)) return undefined;
    const noteStart = text.indexOf(`\n${NOTE_HEADING}\n`);
    if (noteStart === -1) {
        // A note-less message ends at the heading itself.
        return text.endsWith(`\n${NOTE_HEADING}`) ? { note: '' } : undefined;
    }
    return { note: text.slice(noteStart + NOTE_HEADING.length + 2).trim() };
}

/**
 * What the user typed to send `text`: `/new-session <note>` for a hand-off, otherwise `text` itself. Every reading of a
 * sent message as the user's words (Copy, Edit from here, prompt history, queue rows) goes through this, so none of
 * them shows or puts back the instructions the composer wrote for the Agent.
 */
export function agentChatSessionHandoffDraft(text: string): string {
    const handoff = parseAgentChatSessionHandoff(text);
    if (!handoff) return text;
    const command = `/${AGENT_CHAT_SESSION_HANDOFF_COMMAND}`;
    return handoff.note ? `${command} ${handoff.note}` : command;
}
