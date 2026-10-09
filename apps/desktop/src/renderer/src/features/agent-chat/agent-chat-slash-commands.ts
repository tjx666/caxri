import type { AgentChatCommand } from '@caxri/protocol';

/**
 * Slash-command parsing for the Chat composer. The command list is the provider's own (`AgentChatSnapshot.commands`),
 * so the composer never offers or runs a command the provider did not report.
 */

const MAX_SUGGESTIONS = 50;

/**
 * The command name being typed, while the draft is still a bare `/name` with nothing after it; `undefined` once the
 * user has typed a space or anything that is not a command.
 */
export function agentChatSlashQuery(draft: string): string | undefined {
    return /^\/([\w:.-]*)$/u.exec(draft)?.[1];
}

/**
 * Commands matching `query`: names that start with it first, then names that merely contain it, each in the provider's
 * order.
 */
export function filterAgentChatCommands(
    commands: readonly AgentChatCommand[],
    query: string,
): AgentChatCommand[] {
    const needle = query.toLowerCase();
    const starts = commands.filter((command) => command.name.toLowerCase().startsWith(needle));
    const contains = commands.filter(
        (command) =>
            !command.name.toLowerCase().startsWith(needle) &&
            command.name.toLowerCase().includes(needle),
    );
    return [...starts, ...contains].slice(0, MAX_SUGGESTIONS);
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
 * The draft after choosing a command from the list. A command that takes arguments leaves the cursor after a space for
 * them; one that does not runs straight away, so the draft is just its name.
 */
export function completeAgentChatCommand(command: AgentChatCommand): string {
    return command.argumentHint ? `/${command.name} ` : `/${command.name}`;
}

/**
 * DOM id of a suggestion row, for the input's `aria-activedescendant`.
 */
export function agentChatCommandOptionId(listId: string, name: string): string {
    return `${listId}-${name}`;
}
