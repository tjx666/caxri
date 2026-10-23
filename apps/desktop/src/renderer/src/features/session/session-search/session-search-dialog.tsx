import type { KeyboardEvent } from 'react';
import { useEffect, useId } from 'react';

import type { SessionSearchStatusFilter } from '@caxri/protocol';
import { sessionSearchStatusFilters } from '@caxri/protocol';
import { Search } from 'lucide-react';

import { LoadingSkeleton } from '../../../components/loading-skeleton';
import { Button } from '../../../components/ui/button';
import { Dialog, DialogTitle, PickerDialogContent } from '../../../components/ui/dialog';
import { Input, InputGroup } from '../../../components/ui/input';
import { Spinner } from '../../../components/ui/spinner';
import { useTranslation } from '../../../i18n';
import { resolveAgentIcon } from '../../../icons/agents/agent-icon-registry';
import { AgentIdentityIcon } from '../../../icons/agents/agent-identity-icon';
import { isImeComposing } from '../../../lib/ime';
import { setSessionSearchOpen, useDialogStore } from '../../../stores/dialogs';
import { runSessionSearchAction } from './session-search-commands';
import {
    hasActiveSearchFilters,
    nextProviderFilter,
    nextSelectionIndex,
    nextStatusFilter,
    sessionSearchIndexLabel,
    sessionSearchProviders,
} from './session-search-model';
import { SessionSearchResults } from './session-search-results';
import type { SessionSearchModel } from './use-session-search';
import { useSessionSearch } from './use-session-search';

const chipClassName =
    'flex h-6 cursor-pointer items-center gap-1 rounded border-0 bg-transparent px-2 text-[12px] text-muted hover:bg-elevated hover:text-foreground aria-pressed:bg-elevated aria-pressed:text-foreground';

const statusFilterLabelKeys = {
    all: 'session.search.filter.all',
    caxri: 'session.search.filter.caxri',
    archived: 'session.search.filter.archived',
    external: 'session.search.filter.external',
} as const satisfies Record<SessionSearchStatusFilter, string>;

/**
 * Session search (`Command+Shift+S`): every Agent conversation on this machine, open, archived, or never in Caxri,
 * found by title, message text, folder, or ID. A picker over the workbench like the command palette, wider because each
 * row quotes the message that matched.
 */
export function SessionSearchDialog() {
    const isOpen = useDialogStore((state) => state.sessionSearchOpen);
    const { t } = useTranslation();
    return (
        <Dialog open={isOpen} onOpenChange={setSessionSearchOpen}>
            <PickerDialogContent
                aria-label={t('session.search.title')}
                className="top-[12%] flex h-[min(620px,76vh)] w-[min(760px,calc(100vw-48px))] flex-col"
            >
                <SessionSearchBody />
            </PickerDialogContent>
        </Dialog>
    );
}

function SessionSearchBody() {
    const { t } = useTranslation();
    const search = useSessionSearch();
    const rowIdPrefix = useId();
    const resultsId = useId();
    const rowId = (index: number) => `${rowIdPrefix}-${index}`;
    const { entries, selected, selectedIndex, setSelectedIndex } = search;

    useEffect(() => {
        document
            .querySelector(`#${CSS.escape(`${rowIdPrefix}-${selectedIndex}`)}`)
            ?.scrollIntoView({ block: 'nearest' });
    }, [rowIdPrefix, selectedIndex]);

    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
        if (isImeComposing(event)) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setSelectedIndex(
                nextSelectionIndex(
                    entries.length,
                    selectedIndex,
                    event.key === 'ArrowDown' ? 1 : -1,
                ),
            );
            return;
        }
        if (event.key === 'Tab') {
            // Tab cycles the location scope, Shift+Tab the Agent filter; the footer names both.
            event.preventDefault();
            if (event.shiftKey) search.setProvider(nextProviderFilter(search.provider, 1));
            else search.setStatus(nextStatusFilter(search.status, 1));
            return;
        }
        if (selected && event.key === 'Enter') {
            event.preventDefault();
            void runSessionSearchAction(selected, search.searchedQuery);
        }
    };

    return (
        <>
            <DialogTitle className="sr-only">{t('session.search.title')}</DialogTitle>
            <div className="flex flex-none flex-col gap-1.5 border-b border-border p-2">
                <InputGroup appearance="workbench" size="dense">
                    {search.isFetching ? (
                        <Spinner className="size-3.5 shrink-0 text-muted" />
                    ) : (
                        <Search size={14} className="shrink-0 text-muted" />
                    )}
                    <Input
                        autoFocus
                        appearance="embedded"
                        className="flex-1 text-foreground"
                        role="combobox"
                        aria-label={t('session.search.title')}
                        aria-autocomplete="list"
                        aria-controls={resultsId}
                        aria-expanded={entries.length > 0}
                        aria-activedescendant={selected ? rowId(selectedIndex) : undefined}
                        maxLength={200}
                        placeholder={t('session.search.placeholder')}
                        value={search.query}
                        onChange={(event) => search.setQuery(event.target.value)}
                        onKeyDown={onKeyDown}
                    />
                </InputGroup>
                <SessionSearchFilters search={search} />
            </div>
            <SessionSearchContent resultsId={resultsId} rowId={rowId} search={search} />
            <div className="flex h-7 flex-none items-center gap-3 border-t border-border px-3 text-[11px] text-muted">
                <span>{t('session.search.helpMove')}</span>
                <span>{t('session.search.helpAction')}</span>
                <span>{t('session.search.helpFilter')}</span>
                {search.result && (
                    <span
                        className="ml-auto truncate"
                        data-session-search-index={search.result.index.state}
                        role="status"
                    >
                        {search.result.usedSubstringScan
                            ? t('session.search.substringScan')
                            : sessionSearchIndexLabel(search.result, t)}
                    </span>
                )}
            </div>
        </>
    );
}

function SessionSearchFilters({ search }: { search: SessionSearchModel }) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-wrap items-center gap-1">
            <div
                aria-label={t('session.search.statusFilter')}
                className="flex gap-0.5"
                role="group"
            >
                {sessionSearchStatusFilters.map((filter) => (
                    <button
                        key={filter}
                        aria-pressed={search.status === filter}
                        className={chipClassName}
                        data-session-search-status-filter={filter}
                        type="button"
                        onClick={() => search.setStatus(filter)}
                    >
                        {t(statusFilterLabelKeys[filter])}
                    </button>
                ))}
            </div>
            <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
            <div aria-label={t('session.search.agentFilter')} className="flex gap-0.5" role="group">
                <button
                    aria-pressed={search.provider === undefined}
                    className={chipClassName}
                    type="button"
                    onClick={() => search.setProvider(undefined)}
                >
                    {t('session.search.allAgents')}
                </button>
                {sessionSearchProviders.map((provider) => (
                    <button
                        key={provider}
                        aria-pressed={search.provider === provider}
                        className={chipClassName}
                        data-session-search-provider-filter={provider}
                        type="button"
                        onClick={() =>
                            search.setProvider(search.provider === provider ? undefined : provider)
                        }
                    >
                        <AgentIdentityIcon identity={provider} size={12} />
                        {resolveAgentIcon(provider).label}
                    </button>
                ))}
            </div>
        </div>
    );
}

/**
 * An empty list while the index is still being built is not an answer yet, so it says so instead of "no results".
 */
function sessionSearchEmptyKey(search: SessionSearchModel) {
    if (search.result?.index.state === 'indexing') return 'session.search.emptyWhileIndexing';
    return search.query.trim() ? 'session.search.noResults' : 'session.search.noConversations';
}

function SessionSearchContent({
    resultsId,
    rowId,
    search,
}: {
    resultsId: string;
    rowId: (index: number) => string;
    search: SessionSearchModel;
}) {
    const { t } = useTranslation();
    if (search.isError)
        return (
            <div className="flex-1 p-4 text-center text-danger" role="alert">
                {t('session.search.failed')}
            </div>
        );
    if (search.isLoading)
        return (
            <div className="flex-1 p-2">
                <LoadingSkeleton
                    variant="list"
                    rows={6}
                    isImmediate
                    label={t('session.search.searching')}
                />
            </div>
        );
    if (search.entries.length === 0)
        return (
            <div className="flex flex-1 flex-col items-center gap-3 p-4 text-center text-muted">
                <span>{t(sessionSearchEmptyKey(search))}</span>
                {hasActiveSearchFilters(search.status, search.provider) && (
                    <Button size="sm" variant="secondary" onClick={search.clearFilters}>
                        {t('session.search.clearFilters')}
                    </Button>
                )}
            </div>
        );
    return (
        <SessionSearchResults
            entries={search.entries}
            query={search.searchedQuery}
            id={resultsId}
            rowId={rowId}
            selectedIndex={search.selectedIndex}
            onSelect={search.setSelectedIndex}
        />
    );
}
