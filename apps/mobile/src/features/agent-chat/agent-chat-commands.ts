import type { AgentChatCommand } from '@caxri/protocol';
import { agentChatSlashQuery } from '@caxri/protocol';

import { isComposerActionMatch } from '../sessions/composer-suggestions';

/**
 * The list sits above the input inside the keyboard-shrunk screen, so it stays short; typing more of the name narrows
 * it.
 */
export const MOBILE_AGENT_CHAT_COMMAND_ROWS = 6;

/**
 * The provider's commands matching a draft that is still a bare `/name`, or `undefined` when no list should show: the
 * draft is not a command at its start, the user typed past the name, or the provider reported no commands. Unlike
 * Desktop, the phone lists commands only after `/`; `$` skills stay a Desktop menu.
 */
export function agentChatCommandSuggestions(
    draft: string,
    commands: readonly AgentChatCommand[] | undefined,
): readonly AgentChatCommand[] | undefined {
    if (!draft.startsWith('/') || !commands?.length) return undefined;
    const query = agentChatSlashQuery(draft);
    if (query === undefined) return undefined;
    const matches = commands.filter((command) => isComposerActionMatch(`/${command.name}`, query));
    return matches.length > 0 ? matches.slice(0, MOBILE_AGENT_CHAT_COMMAND_ROWS) : undefined;
}

/**
 * What choosing a listed command does. A command without an argument hint runs at once, as on Desktop; one that takes
 * arguments fills the draft with `/name ` so the user types them and submits.
 */
export type AgentChatCommandChoice =
    { kind: 'run'; command: { name: string } } | { kind: 'complete'; draft: string };

export function agentChatCommandChoice(command: AgentChatCommand): AgentChatCommandChoice {
    return command.argumentHint === undefined
        ? { kind: 'run', command: { name: command.name } }
        : { kind: 'complete', draft: `/${command.name} ` };
}
