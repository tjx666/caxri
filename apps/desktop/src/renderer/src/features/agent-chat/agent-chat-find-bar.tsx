import { FindBar } from '../../components/find-bar';
import { useTranslation } from '../../i18n';
import { agentChatFindCountLabel } from './agent-chat-find';

/**
 * The Chat's find bar, at the top right of the conversation like the Terminal's, clear of the message rail on the left
 * and Jump to latest at the bottom. It is docked in its own strip above the conversation (`AgentChatFindScope`) rather
 * than floating over it, so it never covers the transcript text it searches. Escape returns focus to the composer
 * through `onClose`.
 */
export function AgentChatFindBar({
    activeIndex,
    count,
    focusRevision,
    query,
    onClose,
    onNext,
    onPrevious,
    onQueryChange,
}: {
    activeIndex: number;
    count: number;
    focusRevision: number;
    query: string;
    onClose: () => void;
    onNext: () => void;
    onPrevious: () => void;
    onQueryChange: (query: string) => void;
}) {
    const { t } = useTranslation();
    return (
        <FindBar
            ariaLabel={t('agentChat.find.label')}
            countLabel={agentChatFindCountLabel(query, count, activeIndex, t)}
            focusRevision={focusRevision}
            hasMatches={count > 0}
            inputLabel={t('agentChat.find.label')}
            isDocked
            isNoMatch={query !== '' && count === 0}
            query={query}
            onClose={onClose}
            onNext={onNext}
            onPrevious={onPrevious}
            onQueryChange={onQueryChange}
        />
    );
}
