import type { KeyboardEvent } from 'react';
import { useEffect, useId, useMemo, useState } from 'react';

import type { AgentAction, AgentChatCommand } from '@caxri/protocol';

import { isImeComposing } from '../../../lib/ime';
import { suggestionMenuKeyAction, suggestionOptionId } from '../../../lib/suggestion-options';
import { isAgentProcessRunning } from '../../../lib/terminal-agent-runtime';
import { useCaxriQuery } from '../../../queries/client';
import { useTerminal } from '../../../stores/selectors';
import { shouldConfirmUnmatchedSend } from '../agent-chat-presentation';
import {
    agentChatMenuActions,
    agentChatSkillDiscoveryNotice,
    agentChatSlashQuery,
    filterAgentChatActions,
} from '../agent-chat-slash-commands';
import { agentChatActionSuggestion } from '../agent-chat-suggestions';

/**
 * Discovered skills stay fresh enough while the user types a run of invocations, and a new search after a pause
 * re-reads the skill folders the way the picker does on open.
 */
const DISCOVERY_STALE_MS = 30_000;

/**
 * Suggestion state for a draft that is a bare `/name` or `$name`. The list stays open with a `No matching command or
 * skill` row when nothing matches, so a typo reads as a miss instead of the list silently vanishing. Enter on that row
 * does not send at once: the first press only asks for confirmation (`confirmsSendAsText`), so a mistyped command is
 * not sent to the Agent as prose by surprise, and a second Enter on the same draft sends it as text. Escape dismisses
 * the list for the current draft only: any edit brings it back, including clearing the box and typing the same `/`
 * again. Skills are discovered only once the user starts an invocation, and the provider's commands show while
 * discovery runs or when it fails; `skillNotice` says why skills are missing until discovery answers. The list shows
 * only while the input has focus, so it never stays over another surface the user moved to.
 */
export function useAgentChatCommandMenu({
    commands,
    draft,
    isInputFocused,
    terminalId,
}: {
    commands: readonly AgentChatCommand[] | undefined;
    draft: string;
    isInputFocused: boolean;
    terminalId: string;
}) {
    const listId = useId();
    const query = agentChatSlashQuery(draft);
    // Discovery answers only for a running Agent, the same gate as the picker.
    const isAgentRunning = isAgentProcessRunning(useTerminal(terminalId)?.lastAgentProcessState);
    const discovery = useCaxriQuery(
        'agentActions.list',
        { terminalId },
        { enabled: isAgentRunning && query !== undefined, staleTime: DISCOVERY_STALE_MS },
    );
    const actions = useMemo(
        () => agentChatMenuActions(commands, discovery.data?.actions),
        [commands, discovery.data?.actions],
    );
    const [dismissedDraft, setDismissedDraft] = useState<string>();
    /**
     * The dismissal ends at the first edit. Comparing against the dismissed text alone would keep the list closed
     * whenever the draft returned to it, so a `/` dismissed once stayed dismissed after the box was cleared and `/`
     * typed again. Reset during render rather than in an effect:
     * https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
     */
    if (dismissedDraft !== undefined && dismissedDraft !== draft) setDismissedDraft(undefined);
    /**
     * The draft a first Enter on a list with no match was held for; a second Enter on the same draft sends it as text.
     * Any edit ends the confirmation, reset during render like the dismissal above.
     */
    const [confirmingDraft, setConfirmingDraft] = useState<string>();
    if (confirmingDraft !== undefined && confirmingDraft !== draft) setConfirmingDraft(undefined);
    /**
     * Keyed by query so a new search starts at the first match.
     */
    const [active, setActive] = useState({ query, index: 0 });
    const matches =
        query === undefined
            ? []
            : filterAgentChatActions(actions, query, draft.startsWith('$') ? '$' : '/');
    const isOpen = query !== undefined && dismissedDraft !== draft && isInputFocused;
    const activeIndex =
        active.query === query ? Math.min(active.index, Math.max(matches.length - 1, 0)) : 0;
    const activeCommand = isOpen ? matches[activeIndex] : undefined;
    const activeOptionId = activeCommand
        ? suggestionOptionId(listId, activeCommand.invocation)
        : undefined;
    /**
     * The rows never take focus, so the browser does not scroll the active one into view the way it would a focused
     * element; arrowing past the list's visible height has to ask for it, as the command palette does.
     */
    useEffect(() => {
        if (!activeOptionId) return;
        document
            .querySelector(`#${CSS.escape(activeOptionId)}`)
            ?.scrollIntoView({ block: 'nearest' });
    }, [activeOptionId]);
    const move = (delta: number) =>
        setActive({ query, index: (activeIndex + delta + matches.length) % matches.length });
    return {
        isOpen,
        /**
         * The first Enter on a draft no command or skill matches was held; the composer says a second Enter sends the
         * draft as text.
         */
        confirmsSendAsText: isOpen && matches.length === 0 && confirmingDraft === draft,
        matches,
        suggestions: matches.map(agentChatActionSuggestion),
        skillNotice: agentChatSkillDiscoveryNotice({
            isAgentRunning,
            isLoading: discovery.isLoading,
        }),
        activeIndex,
        activeCommand,
        listId,
        /**
         * Autocomplete attributes for the message box. It stays a textbox (multi-line, and the Chat's stable `Message`
         * landmark); the list and its active option still reach assistive technology through these.
         */
        inputAria: {
            'aria-activedescendant': activeOptionId,
            'aria-autocomplete': actions.length > 0 ? ('list' as const) : undefined,
            'aria-controls': isOpen ? listId : undefined,
        },
        highlight: (index: number) => setActive({ query, index }),
        /**
         * Arrow keys move, Tab completes, Enter chooses, and Escape dismisses while the list is open
         * (`suggestionMenuKeyAction`). With no matching row Escape is the menu's, and so is the first Enter, which only
         * asks for confirmation; the second Enter on the same draft falls through and sends it as a message. Returns
         * whether the key was the menu's, so the composer skips its own handling.
         */
        didHandleKey: (
            event: KeyboardEvent<HTMLTextAreaElement>,
            handlers: {
                choose: (action: AgentAction) => void;
                complete: (action: AgentAction) => void;
            },
        ): boolean => {
            if (!isOpen || isImeComposing(event)) return false;
            const action = suggestionMenuKeyAction(event);
            if (
                action === 'choose' &&
                shouldConfirmUnmatchedSend({ confirmingDraft, draft, matchCount: matches.length })
            ) {
                event.preventDefault();
                setConfirmingDraft(draft);
                return true;
            }
            if (!action || (action !== 'dismiss' && !activeCommand)) return false;
            event.preventDefault();
            if (action === 'next' || action === 'previous') move(action === 'next' ? 1 : -1);
            else if (action === 'dismiss') setDismissedDraft(draft);
            else if (activeCommand) handlers[action](activeCommand);
            return true;
        },
    };
}
