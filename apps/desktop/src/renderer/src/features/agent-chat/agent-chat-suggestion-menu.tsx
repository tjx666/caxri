import type { AgentAction } from '@caxri/protocol';
import { noop } from 'es-toolkit';

import { SuggestionList } from '../../components/suggestion-list';
import type { SuggestionOption } from '../../lib/suggestion-options';
import { agentChatMenuGroupHeading } from './agent-chat-slash-commands';
import { agentChatSuggestionFooter } from './agent-chat-suggestions';

interface SuggestionMenuState {
    activeIndex: number;
    highlight: (index: number) => void;
    isOpen: boolean;
    listId: string;
    suggestions: readonly SuggestionOption[];
}

/**
 * The composer's two lists, of which at most one shows: the slash-command list wins while open, otherwise the `@`
 * Sessions list, or its progress row while a chosen Session's reference is written.
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
    sessionMenu: SuggestionMenuState & {
        chooseAt: (index: number) => void;
        emptyText: string;
        preparingText: string | undefined;
    };
}) {
    if (commandMenu.isOpen)
        return (
            <SuggestionList
                activeIndex={commandMenu.activeIndex}
                emptyText="No matching command or skill"
                footer={agentChatSuggestionFooter('commands', commandMenu.suggestions.length > 0)}
                headingAt={(index) => agentChatMenuGroupHeading(commandMenu.matches, index)}
                label="Commands and skills"
                listId={commandMenu.listId}
                notice={commandMenu.skillNotice}
                suggestions={commandMenu.suggestions}
                onChoose={onChooseCommand}
                onHover={commandMenu.highlight}
            />
        );
    if (sessionMenu.preparingText)
        return (
            <SuggestionList
                activeIndex={-1}
                label="Sessions"
                listId={sessionMenu.listId}
                notice={{ text: sessionMenu.preparingText, isLoading: true }}
                suggestions={[]}
                onChoose={noop}
                onHover={noop}
            />
        );
    if (!sessionMenu.isOpen) return null;
    return (
        <SuggestionList
            activeIndex={sessionMenu.activeIndex}
            emptyText={sessionMenu.emptyText}
            footer={agentChatSuggestionFooter('sessions', sessionMenu.suggestions.length > 0)}
            headingAt={(index) => (index === 0 ? 'Sessions' : undefined)}
            label="Sessions"
            listId={sessionMenu.listId}
            suggestions={sessionMenu.suggestions}
            onChoose={sessionMenu.chooseAt}
            onHover={sessionMenu.highlight}
        />
    );
}
