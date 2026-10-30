import type { KeyboardEvent } from 'react';
import { useId } from 'react';

import { Search } from 'lucide-react';

import { LoadingSkeleton } from '../../../components/loading-skeleton';
import { Button } from '../../../components/ui/button';
import { Dialog, DialogTitle, PickerDialogContent } from '../../../components/ui/dialog';
import { Input, InputGroup } from '../../../components/ui/input';
import { Spinner } from '../../../components/ui/spinner';
import { useTranslation } from '../../../i18n';
import { isImeComposing } from '../../../lib/ime';
import { setSessionSearchOpen, useDialogStore } from '../../../stores/dialogs';
import { runSessionSearchAction } from './session-search-commands';
import { SessionSearchFilters } from './session-search-filters';
import {
    hasActiveSearchFilters,
    nextProviderFilter,
    nextSelectionIndex,
    nextStatusFilter,
    sessionSearchIndexLabel,
    sessionSearchRelaxationNoticeKey,
} from './session-search-model';
import { SessionSearchPreview } from './session-search-preview';
import { SessionSearchResults } from './session-search-results';
import type { SessionSearchModel } from './use-session-search';
import { useSessionSearch } from './use-session-search';
import { useSessionSearchPreview } from './use-session-search-preview';

/**
 * Session search (`Command+Shift+S`): every Agent conversation on this machine, open, archived, or never in Caxri,
 * found by title, message text, folder, or ID. A picker over the workbench like the command palette, wider because each
 * row quotes the message that matched.
 */
export function SessionSearchDialog() {
    const isOpen = useDialogStore((state) => state.sessionSearchOpen);
    const requestId = useDialogStore((state) => state.sessionSearchRequest.id);
    const { t } = useTranslation();
    return (
        <Dialog open={isOpen} onOpenChange={setSessionSearchOpen}>
            <PickerDialogContent
                aria-label={t('session.search.title')}
                className="top-[12%] flex h-[min(620px,76vh)] w-[min(1080px,calc(100vw-48px))] flex-col"
            >
                <SessionSearchBody key={requestId} />
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
    const preview = useSessionSearchPreview(selected, search.searchedQuery);

    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
        if (isImeComposing(event)) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (event.altKey) {
                preview.stepMatch(event.key === 'ArrowDown' ? 1 : -1);
                return;
            }
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
        // Alt+S and Alt+P are read from the physical key: on macOS Option+letter types a different character.
        if (event.altKey && !event.metaKey && !event.ctrlKey && event.code === 'KeyS') {
            event.preventDefault();
            search.setSort(search.sort === 'relevance' ? 'recent' : 'relevance');
            return;
        }
        if (
            event.altKey &&
            !event.metaKey &&
            !event.ctrlKey &&
            event.code === 'KeyP' &&
            search.hasCurrentProject
        ) {
            event.preventDefault();
            search.setScope(search.scope === 'currentProject' ? 'allProjects' : 'currentProject');
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
            <div className="@container flex min-h-0 flex-1 flex-col">
                <div className="flex min-h-0 flex-1 flex-col @3xl:flex-row">
                    <div className="flex min-h-0 min-w-0 flex-[3] flex-col @3xl:flex-1">
                        <SessionSearchContent resultsId={resultsId} rowId={rowId} search={search} />
                    </div>
                    {selected && search.entries.length > 0 && (
                        <div className="flex min-h-0 flex-[2] flex-col border-t border-border @3xl:w-[46%] @3xl:flex-none @3xl:border-t-0 @3xl:border-l">
                            <SessionSearchPreview
                                entry={selected}
                                hasQuery={search.searchedQuery !== ''}
                                preview={preview}
                            />
                        </div>
                    )}
                </div>
            </div>
            <div className="flex h-7 flex-none items-center gap-3 border-t border-border px-3 text-[11px] text-muted">
                <span>{t('session.search.helpMove')}</span>
                <span>{t('session.search.helpAction')}</span>
                <span>{t('session.search.helpMatch')}</span>
                <span>{t('session.search.helpFilter')}</span>
                <span>{t('session.search.helpSort')}</span>
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
    const relaxedKey = sessionSearchRelaxationNoticeKey(search.result?.relaxation);
    return (
        <>
            {relaxedKey && (
                <div
                    className="flex-none border-b border-border bg-elevated px-3 py-1.5 text-[12px] text-muted"
                    data-session-search-relaxation={search.result?.relaxation}
                    role="status"
                >
                    {t(relaxedKey)}
                </div>
            )}
            <SessionSearchResults
                entries={search.entries}
                query={search.searchedQuery}
                id={resultsId}
                rowId={rowId}
                selectedIndex={search.selectedIndex}
                onSelect={search.setSelectedIndex}
            />
        </>
    );
}
