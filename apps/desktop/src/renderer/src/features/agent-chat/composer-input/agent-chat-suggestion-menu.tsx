import type { AgentAction } from '@caxri/protocol';
import { agentChatMenuGroupHeading } from '@caxri/protocol';
import { noop } from 'es-toolkit';
import { History, MessageCircle, Package, SquareSlash } from 'lucide-react';

import { SuggestionList } from '../../../components/suggestion-list';
import { useTranslation } from '../../../i18n';
import { FileTypeIcon } from '../../../icons/files/file-type-icon';
import type { SuggestionOption } from '../../../lib/suggestion-options';
import { agentChatSuggestionFooter } from './agent-chat-suggestions';

const ICON_CLASS_NAME = 'size-3.5';

const AGENT_CHAT_MENU_HEADING_KEYS = {
    Commands: 'agentChat.slash.commands',
    Recent: 'agentChat.slash.recent',
    Skills: 'agentChat.slash.skills',
} as const satisfies Record<NonNullable<ReturnType<typeof agentChatMenuGroupHeading>>, string>;

interface SuggestionMenuState {
    activeIndex: number;
    highlight: (index: number) => void;
    isOpen: boolean;
    listId: string;
    suggestions: readonly SuggestionOption[];
}

/**
 * The composer's lists, of which at most one shows: the prompt history while browsing it, then the slash-command list
 * while open, otherwise the `@` list of Project files and Sessions, or its progress row while a chosen Session's
 * reference is written. Each row leads with what it is: the `/command` and `$skill` glyphs the sent message's chip
 * wears, a file's type icon as the Files tree draws it, and the Add menu's Session glyph.
 */
export function AgentChatSuggestionMenu({
    commandMenu,
    historyMenu,
    onChooseCommand,
    sessionMenu,
}: {
    commandMenu: SuggestionMenuState & {
        matches: readonly AgentAction[];
        recentCount: number;
        skillNotice: { text: string; isLoading: boolean } | undefined;
    };
    /**
     * The prompts this Chat sent, opened by ArrowUp in an empty input; it opens only while the other two are closed.
     */
    historyMenu: SuggestionMenuState & { chooseAt: (index: number) => void };
    onChooseCommand: (index: number) => void;
    sessionMenu: SuggestionMenuState & {
        chooseAt: (index: number) => void;
        groupAt: (index: number) => 'files' | 'sessions' | undefined;
        isFileAt: (index: number) => boolean;
        preparingText: string | undefined;
    };
}) {
    const { t } = useTranslation();
    if (historyMenu.isOpen)
        return (
            <SuggestionList
                activeIndex={historyMenu.activeIndex}
                footer={agentChatSuggestionFooter('history', historyMenu.suggestions.length > 0)}
                headingAt={(index) => (index === 0 ? t('agentChat.history.label') : undefined)}
                iconAt={() => <History className={ICON_CLASS_NAME} />}
                label={t('agentChat.history.label')}
                listId={historyMenu.listId}
                suggestions={historyMenu.suggestions}
                onChoose={historyMenu.chooseAt}
                onHover={historyMenu.highlight}
            />
        );
    if (commandMenu.isOpen)
        return (
            <SuggestionList
                activeIndex={commandMenu.activeIndex}
                emptyText={t('agentChat.slash.noMatches')}
                footer={agentChatSuggestionFooter(
                    'commands',
                    commandMenu.suggestions.length > 0,
                    commandMenu.matches[commandMenu.activeIndex],
                )}
                headingAt={(index) => {
                    const heading = agentChatMenuGroupHeading(
                        commandMenu.matches,
                        index,
                        commandMenu.recentCount,
                    );
                    if (heading === undefined) return;
                    return t(AGENT_CHAT_MENU_HEADING_KEYS[heading]);
                }}
                iconAt={(index) =>
                    commandMenu.matches[index]?.kind === 'skill' ? (
                        <Package className={ICON_CLASS_NAME} />
                    ) : (
                        <SquareSlash className={ICON_CLASS_NAME} />
                    )
                }
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
            footer={agentChatSuggestionFooter('sessions', sessionMenu.suggestions.length > 0)}
            headingAt={(index) => {
                const group = sessionMenu.groupAt(index);
                if (group === undefined) return;
                return t(group === 'files' ? 'agentChat.slash.files' : 'agentChat.slash.sessions');
            }}
            iconAt={(index) =>
                sessionMenu.isFileAt(index) ? (
                    <FileTypeIcon
                        entry={{ kind: 'file', name: sessionMenu.suggestions[index]?.label ?? '' }}
                    />
                ) : (
                    <MessageCircle className={ICON_CLASS_NAME} />
                )
            }
            label={t('agentChat.slash.mentions')}
            listId={sessionMenu.listId}
            suggestions={sessionMenu.suggestions}
            onChoose={sessionMenu.chooseAt}
            onHover={sessionMenu.highlight}
        />
    );
}
