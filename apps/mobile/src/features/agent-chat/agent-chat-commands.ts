import type { AgentAction, AgentChatCommand } from '@caxri/protocol';
import {
    agentChatDraftMatches,
    agentChatMenuActions,
    agentChatSlashQuery,
    completeAgentChatAction,
} from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';

/**
 * Rows the menu shows before it scrolls. It sits above the input inside the keyboard-shrunk screen, so it stays short;
 * typing more of the name narrows it.
 */
export const MOBILE_AGENT_CHAT_COMMAND_ROWS = 6;

/**
 * The menu rows for a draft, as on Desktop: the provider's commands, then the skills discovered for the Agent's
 * Terminal, ranked by name and description (`agentChatDraftMatches`) and led by the group the typed sigil names. A
 * skill the provider already lists as a command keeps its runnable command row. `undefined` when no menu should show:
 * the draft is not a bare invocation, or there is no command or skill to offer. An empty list keeps the menu open on
 * Desktop's `No matching command or skill`, so a typo reads as a miss instead of the menu silently vanishing.
 */
export function agentChatMenuMatches(
    draft: string,
    commands: readonly AgentChatCommand[] | undefined,
    skills: readonly AgentAction[] | undefined,
): AgentAction[] | undefined {
    if (agentChatSlashQuery(draft) === undefined) return undefined;
    const actions = agentChatMenuActions(commands, skills);
    return actions.length === 0 ? undefined : agentChatDraftMatches(actions, draft);
}

/**
 * Whether a send of `draft` is held for confirmation instead of going out, as Desktop's first Enter on a menu with no
 * match is: a mistyped `/command` is not sent to the Agent as prose by surprise. `matches` is the menu's rows
 * (`agentChatMenuMatches`), and `confirmedDraft` the draft a first tap was held for; a second tap on the same draft
 * sends it as text. A `$skill` is ordinary text to the provider, so it is never held.
 */
export function shouldHoldAgentChatSendAsText({
    confirmedDraft,
    draft,
    matches,
}: {
    confirmedDraft: string | undefined;
    draft: string;
    matches: readonly AgentAction[] | undefined;
}): boolean {
    return draft.startsWith('/') && matches?.length === 0 && confirmedDraft !== draft;
}

/**
 * The line the menu shows about skills, or `undefined` once discovery has answered. Skills are discovered from the
 * running Agent, so a stopped one (`UNAVAILABLE`) gets a quiet note instead of an error, and the first discovery takes
 * a moment.
 */
export interface AgentChatSkillNotice {
    text: string;
    isLoading: boolean;
}

export function agentChatSkillNotice(
    state: {
        isPending: boolean;
        isUnavailable: boolean;
    },
    t: Translate = translate,
): AgentChatSkillNotice | undefined {
    if (state.isUnavailable) return { text: t('chat.commands.skillsNeedAgent'), isLoading: false };
    return state.isPending
        ? { text: t('chat.commands.loadingSkills'), isLoading: true }
        : undefined;
}

/**
 * What choosing a menu row does. A provider command without an argument hint runs at once, as on Desktop; one that
 * takes arguments, and every skill, fills the draft with the invocation and a space so the user types what to ask
 * (`completeAgentChatAction`).
 */
export type AgentChatCommandChoice =
    { kind: 'run'; command: { name: string } } | { kind: 'complete'; draft: string };

export function agentChatCommandChoice(action: AgentAction): AgentChatCommandChoice {
    return action.kind === 'command' && !action.argumentHint
        ? { kind: 'run', command: { name: action.invocation.slice(1) } }
        : { kind: 'complete', draft: completeAgentChatAction(action) };
}
