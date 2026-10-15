import type { AgentAction } from '@caxri/protocol';
import { agentChatMenuGroupHeading } from '@caxri/protocol';
import { noop } from 'es-toolkit';

import { SuggestionList } from '../../components/suggestion-list';
import { useTranslation } from '../../i18n';
import type { SuggestionOption } from '../../lib/suggestion-options';
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
    const { t } = useTranslation();
    if (commandMenu.isOpen)
        return (
            <SuggestionList
                activeIndex={commandMenu.activeIndex}
                emptyText={t('agentChat.slash.noMatches')}
                footer={agentChatSuggestionFooter('commands', commandMenu.suggestions.length > 0)}
                headingAt={(index) => {
                    const heading = agentChatMenuGroupHeading(commandMenu.matches, index);
                    if (heading === undefined) return;
                    return t(
                        heading === 'Commands'
                            ? 'agentChat.slash.commands'
                            : 'agentChat.slash.skills',
                    );
                }}
                label={t('agentChat.slash.label')}
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
                label={t('agentChat.slash.sessions')}
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
            headingAt={(index) => (index === 0 ? t('agentChat.slash.sessions') : undefined)}
            label={t('agentChat.slash.sessions')}
            listId={sessionMenu.listId}
            suggestions={sessionMenu.suggestions}
            onChoose={sessionMenu.chooseAt}
            onHover={sessionMenu.highlight}
        />
    );
}
