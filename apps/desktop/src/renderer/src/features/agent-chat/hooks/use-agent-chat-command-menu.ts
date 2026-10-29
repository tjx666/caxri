import { useEffect, useId, useMemo, useState } from 'react';

import type { AgentAction, AgentChatCommand, AgentProvider } from '@caxri/protocol';
import {
    agentChatDraftMatches,
    agentChatMenuActions,
    agentChatRecentMenuActions,
    agentChatSlashQuery,
} from '@caxri/protocol';

import { useTranslation } from '../../../i18n';
import { isImeComposing } from '../../../lib/ime';
import { suggestionMenuKeyAction, suggestionOptionId } from '../../../lib/suggestion-options';
import { isAgentProcessRunning } from '../../../lib/terminal-agent-runtime';
import { useCaxriQuery } from '../../../queries/client';
import { useSettings, useTerminal } from '../../../stores/selectors';
import type { AgentChatComposerKeyEvent } from '../composer/agent-chat-composer-view';
import {
    agentChatLeadingInvocation,
    agentChatSkillDiscoveryNotice,
    withAgentChatBuiltInActions,
} from '../composer-input/agent-chat-slash-commands';
import { agentChatActionSuggestion } from '../composer-input/agent-chat-suggestions';
import { agentChatCommandMenuKeyStep } from '../transcript/agent-chat-presentation';

/**
 * Discovered skills stay fresh enough while the user types a run of invocations, and a new search after a pause
 * re-reads the skill folders the way the picker does on open.
 */
export const AGENT_ACTION_DISCOVERY_STALE_MS = 30_000;

/**
 * The provider's recently used invocations, most recent first (`AgentActionsSettings.recent`).
 */
function useProviderRecentInvocations(provider: AgentProvider | undefined): readonly string[] {
    const settings = useSettings();
    return (provider && settings?.['agents.providers'][provider].actions.recent.invocations) ?? [];
}

/**
 * Whether the draft needs the discovered skills: it is a bare `/name` for the menu, or it already starts with an
 * invocation (history recall, a stash), whose chip is recognized without opening the menu.
 */
function requiresSkillDiscovery(draft: string): boolean {
    return (
        agentChatSlashQuery(draft) !== undefined || agentChatLeadingInvocation(draft) !== undefined
    );
}

/**
 * Suggestion state for a draft that is a bare `/name` or `$name`. The list stays open with a `No matching command or
 * skill` row when nothing matches, so a typo reads as a miss instead of the list silently vanishing. Enter on that row
 * does not send at once: the first press only asks for confirmation (`confirmsSendAsText`), so a mistyped command is
 * not sent to the Agent as prose by surprise, and a second Enter on the same draft sends it as text. Escape dismisses
 * the list for the current draft only: any edit brings it back, including clearing the box and typing the same `/`
 * again. Skills are discovered only once the user starts an invocation, and the provider's commands show while
 * discovery runs or when it fails; `skillNotice` says why skills are missing until discovery answers. The list shows
 * only while the input has focus, so it never stays over another surface the user moved to. A bare `/` or `$` leads
 * with the provider's recently used rows, the same recents the Agent Commands & Skills picker records and shows.
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
    const { t } = useTranslation();
    const listId = useId();
    const query = agentChatSlashQuery(draft);
    // Discovery answers only for a running Agent, the same gate as the picker.
    const terminal = useTerminal(terminalId);
    const isAgentRunning = isAgentProcessRunning(terminal?.lastAgentProcessState);
    const recent = useProviderRecentInvocations(terminal?.provider);
    const discovery = useCaxriQuery(
        'agentActions.list',
        { terminalId },
        {
            enabled: isAgentRunning && requiresSkillDiscovery(draft),
            staleTime: AGENT_ACTION_DISCOVERY_STALE_MS,
        },
    );
    const actions = useMemo(
        () =>
            withAgentChatBuiltInActions(agentChatMenuActions(commands, discovery.data?.actions), t),
        [commands, discovery.data?.actions, t],
    );
    const knownInvocations = useMemo(
        () => new Set(actions.map((action) => action.invocation)),
        [actions],
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
    const matches = agentChatDraftMatches(actions, draft, recent);
    const recentCount = agentChatRecentMenuActions(actions, draft, recent).length;
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
         * Every `/command` and `$skill` the menu offers, which the composer recognizes a leading token against.
         */
        knownInvocations,
        /**
         * The first Enter on a draft no command or skill matches was held; the composer says a second Enter sends the
         * draft as text.
         */
        confirmsSendAsText: isOpen && matches.length === 0 && confirmingDraft === draft,
        matches,
        /**
         * How many leading `matches` are the recently used group (`agentChatMenuGroupHeading`).
         */
        recentCount,
        suggestions: matches.map(agentChatActionSuggestion),
        skillNotice: agentChatSkillDiscoveryNotice(
            {
                isAgentRunning,
                isLoading: discovery.isLoading,
            },
            t,
        ),
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
            event: AgentChatComposerKeyEvent,
            handlers: {
                choose: (action: AgentAction) => void;
                complete: (action: AgentAction) => void;
            },
        ): boolean => {
            if (!isOpen || isImeComposing(event)) return false;
            const step = agentChatCommandMenuKeyStep(suggestionMenuKeyAction(event), {
                confirmingDraft,
                draft,
                matchCount: matches.length,
                hasActiveCommand: activeCommand !== undefined,
            });
            if (!step) return false;
            event.preventDefault();
            switch (step.kind) {
                case 'confirm': {
                    setConfirmingDraft(draft);
                    break;
                }
                case 'move': {
                    move(step.delta);
                    break;
                }
                case 'dismiss': {
                    setDismissedDraft(draft);
                    break;
                }
                default:
                    if (activeCommand) handlers[step.handler](activeCommand);
            }
            return true;
        },
    };
}
