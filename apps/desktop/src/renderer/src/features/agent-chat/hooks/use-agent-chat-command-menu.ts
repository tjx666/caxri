import type { KeyboardEvent } from 'react';
import { useId, useState } from 'react';

import type { AgentChatCommand } from '@caxri/protocol';

import {
    agentChatCommandOptionId,
    agentChatSlashQuery,
    filterAgentChatCommands,
} from '../agent-chat-slash-commands';

/**
 * Suggestion state for a draft that is a bare `/name`. Escape dismisses the list for the current draft only, so typing
 * another character brings it back.
 */
export function useAgentChatCommandMenu(
    draft: string,
    commands: readonly AgentChatCommand[] | undefined,
) {
    const listId = useId();
    const query = agentChatSlashQuery(draft);
    const [dismissedDraft, setDismissedDraft] = useState<string>();
    /**
     * Keyed by query so a new search starts at the first match.
     */
    const [active, setActive] = useState({ query, index: 0 });
    const matches = query === undefined ? [] : filterAgentChatCommands(commands ?? [], query);
    const isOpen = matches.length > 0 && dismissedDraft !== draft;
    const activeIndex = active.query === query ? Math.min(active.index, matches.length - 1) : 0;
    const activeCommand = isOpen ? matches[activeIndex] : undefined;
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
            'aria-activedescendant': activeCommand
                ? agentChatCommandOptionId(listId, activeCommand.name)
                : undefined,
            'aria-autocomplete': commands?.length ? ('list' as const) : undefined,
            'aria-controls': isOpen ? listId : undefined,
        },
        highlight: (index: number) => setActive({ query, index }),
        /**
         * Arrow keys move, Tab or Enter chooses, and Escape dismisses while the list is open. Returns whether the key
         * was the menu's, so the composer skips its own handling.
         */
        didHandleKey: (
            event: KeyboardEvent<HTMLTextAreaElement>,
            choose: (command: AgentChatCommand) => void,
        ): boolean => {
            if (!activeCommand || event.nativeEvent.isComposing) return false;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp')
                move(event.key === 'ArrowDown' ? 1 : -1);
            else if (event.key === 'Escape') setDismissedDraft(draft);
            else if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey))
                choose(activeCommand);
            else return false;
            event.preventDefault();
            return true;
        },
    };
}
