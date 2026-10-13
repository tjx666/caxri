import type { AgentChatCommand } from '@caxri/protocol';
import { agentChatSlashQuery } from '@caxri/protocol';

import { isComposerActionMatch } from '../sessions/composer-suggestions';

/**
 * The list sits above the input inside the keyboard-shrunk screen, so it stays short; past this many matches a last row
 * asks the user to keep typing to narrow it.
 */
export const MOBILE_AGENT_CHAT_COMMAND_ROWS = 6;

/**
 * The command list for a draft that is still a bare `/name`: the first matches, whether more were cut (`hasMore`, shown
 * as a `Keep typing to narrow` row), and an empty `matches` when nothing matches, shown as Desktop's `No matching
 * command or skill` row so a typo reads as a miss instead of the list silently vanishing.
 */
export interface AgentChatCommandMenu {
    matches: readonly AgentChatCommand[];
    hasMore: boolean;
}

/**
 * The command list a draft opens, or `undefined` when no list should show: the draft is not a command at its start, the
 * user typed past the name, or the provider reported no commands. Unlike Desktop, the phone lists commands only after
 * `/`; `$` skills stay a Desktop menu.
 */
export function agentChatCommandMenu(
    draft: string,
    commands: readonly AgentChatCommand[] | undefined,
): AgentChatCommandMenu | undefined {
    if (!draft.startsWith('/') || !commands?.length) return undefined;
    const query = agentChatSlashQuery(draft);
    if (query === undefined) return undefined;
    const matches = commands.filter((command) => isComposerActionMatch(`/${command.name}`, query));
    return {
        matches: matches.slice(0, MOBILE_AGENT_CHAT_COMMAND_ROWS),
        hasMore: matches.length > MOBILE_AGENT_CHAT_COMMAND_ROWS,
    };
}

/**
 * Whether a send of `draft` is held for confirmation instead of going out, as Desktop's first Enter on a list with no
 * match is: a mistyped `/command` is not sent to the Agent as prose by surprise. `confirmedDraft` is the draft a first
 * tap was held for; a second tap on the same draft sends it as text.
 */
export function shouldHoldAgentChatSendAsText({
    commands,
    confirmedDraft,
    draft,
}: {
    commands: readonly AgentChatCommand[] | undefined;
    confirmedDraft: string | undefined;
    draft: string;
}): boolean {
    return agentChatCommandMenu(draft, commands)?.matches.length === 0 && confirmedDraft !== draft;
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
