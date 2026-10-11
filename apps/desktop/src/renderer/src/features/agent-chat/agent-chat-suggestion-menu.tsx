import type { AgentAction } from '@caxri/protocol';

import { SuggestionList } from '../../components/suggestion-list';
import type { SuggestionOption } from '../../lib/suggestion-options';
import { agentChatMenuGroupHeading } from './agent-chat-slash-commands';

interface SuggestionMenuState {
    activeIndex: number;
    highlight: (index: number) => void;
    isOpen: boolean;
    listId: string;
    suggestions: readonly SuggestionOption[];
}

/**
 * The composer's two lists, of which at most one shows: the slash-command list wins while open, otherwise the `@`
 * Sessions list.
 */
export function AgentChatSuggestionMenu({
    commandMenu,
    onChooseCommand,
    sessionMenu,
}: {
    commandMenu: SuggestionMenuState & {
        matches: readonly AgentAction[];
        skillNotice: { text: string; isLoading: boolean } | undefined;
    };
    onChooseCommand: (index: number) => void;
    sessionMenu: SuggestionMenuState & { chooseAt: (index: number) => void };
}) {
    if (commandMenu.isOpen)
        return (
            <SuggestionList
                activeIndex={commandMenu.activeIndex}
                emptyText="No matching command or skill"
                footer="↑↓ to move · Tab to complete · Enter to run"
                headingAt={(index) => agentChatMenuGroupHeading(commandMenu.matches, index)}
                label="Commands and skills"
                listId={commandMenu.listId}
                notice={commandMenu.skillNotice}
                suggestions={commandMenu.suggestions}
                onChoose={onChooseCommand}
                onHover={commandMenu.highlight}
            />
        );
    if (!sessionMenu.isOpen) return null;
    return (
        <SuggestionList
            activeIndex={sessionMenu.activeIndex}
            footer="↑↓ to move · Enter to cite"
            headingAt={(index) => (index === 0 ? 'Sessions' : undefined)}
            label="Sessions"
            listId={sessionMenu.listId}
            suggestions={sessionMenu.suggestions}
            onChoose={sessionMenu.chooseAt}
            onHover={sessionMenu.highlight}
        />
    );
}
