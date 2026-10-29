import { History } from 'lucide-react';

import { FindBar } from '../../../components/find-bar';
import { Button } from '../../../components/ui/button';
import { useTranslation } from '../../../i18n';
import { agentChatFindCountLabel, canAgentChatFindSearchEarlier } from './agent-chat-find';

/**
 * The Chat's find bar, at the top right of the conversation like the Terminal's, clear of the message rail on the left
 * and Jump to latest at the bottom. It is docked in its own strip above the conversation (`AgentChatFindScope`) rather
 * than floating over it, so it never covers the transcript text it searches. Escape returns focus to the composer
 * through `onClose`. When nothing matches in the loaded messages and older history can still load, Search earlier
 * messages under the bar loads the next page; find repaints as it arrives and reveals the nearest earlier match.
 */
export function AgentChatFindBar({
    activeIndex,
    count,
    focusRevision,
    isLoadingEarlier,
    isPartial,
    query,
    onClose,
    onNext,
    onPrevious,
    onQueryChange,
    onSearchEarlier,
}: {
    activeIndex: number;
    count: number;
    focusRevision: number;
    isLoadingEarlier: boolean;
    /**
     * Older history exists that find has not searched, because it is not loaded or cannot be shown in Chat.
     */
    isPartial: boolean;
    query: string;
    onClose: () => void;
    onNext: () => void;
    onPrevious: () => void;
    onQueryChange: (query: string) => void;
    /**
     * Loads older history to search, or `undefined` when there is none to load.
     */
    onSearchEarlier?: () => void;
}) {
    const { t } = useTranslation();
    const canSearchEarlier = canAgentChatFindSearchEarlier(
        query,
        count,
        onSearchEarlier !== undefined,
    );
    return (
        <>
            <FindBar
                ariaLabel={t('agentChat.find.label')}
                countLabel={agentChatFindCountLabel(query, count, activeIndex, t, { isPartial })}
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
            {canSearchEarlier && (
                <div className="flex shrink-0 justify-end px-2 pt-1">
                    <Button
                        aria-disabled={isLoadingEarlier}
                        className="gap-1 text-[12px] text-muted not-aria-disabled:hover:text-foreground"
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                            if (!isLoadingEarlier) onSearchEarlier?.();
                        }}
                    >
                        <History aria-hidden="true" className="size-3.5" />
                        {t(
                            isLoadingEarlier
                                ? 'agentChat.find.searchingEarlier'
                                : 'agentChat.find.searchEarlier',
                        )}
                    </Button>
                </div>
            )}
        </>
    );
}
