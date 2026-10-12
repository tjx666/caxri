import type { AgentChatCommand } from './agent-chat-contract.js';

/**
 * How every Chat composer (Desktop and the phone) reads a draft against the provider's runnable commands
 * (`AgentChatSnapshot.commands`), so no composer runs a command the provider did not report.
 */

/**
 * The name being typed while the draft is still a bare `/name` or `$name` with nothing after it; `undefined` once the
 * user has typed a space or anything that is not an invocation. Desktop searches commands and skills alike under either
 * prefix, so a user does not need to know which one the provider spells with `$`; the phone lists commands only, after
 * `/`.
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
