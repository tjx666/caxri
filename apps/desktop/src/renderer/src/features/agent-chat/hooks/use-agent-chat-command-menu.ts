import type { KeyboardEvent } from 'react';
import { useEffect, useId, useMemo, useState } from 'react';

import type { AgentAction, AgentChatCommand } from '@caxri/protocol';

import { isAgentProcessRunning } from '../../../lib/terminal-agent-runtime';
import { useCaxriQuery } from '../../../queries/client';
import { useTerminal } from '../../../stores/selectors';
import {
    agentChatCommandOptionId,
    agentChatMenuActions,
    agentChatMenuKeyAction,
    agentChatSlashQuery,
    filterAgentChatActions,
} from '../agent-chat-slash-commands';

/**
 * Discovered skills stay fresh enough while the user types a run of invocations, and a new search after a pause
 * re-reads the skill folders the way the picker does on open.
 */
const DISCOVERY_STALE_MS = 30_000;

/**
 * Suggestion state for a draft that is a bare `/name` or `$name`. Escape dismisses the list for the current draft only,
 * so typing another character brings it back. Skills are discovered only once the user starts an invocation, and the
 * provider's commands show while discovery runs or when it fails.
 */
export function useAgentChatCommandMenu({
    commands,
    draft,
    terminalId,
}: {
    commands: readonly AgentChatCommand[] | undefined;
    draft: string;
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
     * Keyed by query so a new search starts at the first match.
     */
    const [active, setActive] = useState({ query, index: 0 });
    const matches = query === undefined ? [] : filterAgentChatActions(actions, query);
    const isOpen = matches.length > 0 && dismissedDraft !== draft;
    const activeIndex = active.query === query ? Math.min(active.index, matches.length - 1) : 0;
    const activeCommand = isOpen ? matches[activeIndex] : undefined;
    const activeOptionId = activeCommand
        ? agentChatCommandOptionId(listId, activeCommand.invocation)
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
        matches,
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
         * (`agentChatMenuKeyAction`). Returns whether the key was the menu's, so the composer skips its own handling.
         */
        didHandleKey: (
            event: KeyboardEvent<HTMLTextAreaElement>,
            handlers: {
                choose: (action: AgentAction) => void;
                complete: (action: AgentAction) => void;
            },
        ): boolean => {
            if (!activeCommand || event.nativeEvent.isComposing) return false;
            const action = agentChatMenuKeyAction(event);
            if (!action) return false;
            event.preventDefault();
            if (action === 'next' || action === 'previous') move(action === 'next' ? 1 : -1);
            else if (action === 'dismiss') setDismissedDraft(draft);
            else handlers[action](activeCommand);
            return true;
        },
    };
}
