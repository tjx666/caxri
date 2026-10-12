import type { KeyboardEvent } from 'react';
import { useEffect, useId, useRef, useState } from 'react';

import type { FileSearchMatch } from '@caxri/protocol';
import { editorModelPath } from '@desktop-shared/editor-state';

import { Dialog, DialogTitle, PickerDialogContent } from '../../components/ui/dialog';
import { useTranslation } from '../../i18n';
import { isImeComposing } from '../../lib/ime';
import { setProjectSearchOpen, useDialogStore } from '../../stores/dialogs';
import { sessionViewScope } from '../../stores/session-view';
import { openFile } from '../editor/document-commands';
import { revealEditorMatch } from '../editor/editor-reveal';
import { findPaneTabId, getActivePaneId, splitPaneTab } from '../workbench/pane-actions';
import { ProjectSearchControls } from './project-search-controls';
import { ProjectSearchPreview } from './project-search-preview';
import { ProjectSearchResults } from './project-search-results';
import { nextSelectionIndex, searchMatchKey } from './project-search-selection';
import type { ProjectSearchDisplayState } from './project-search-status';
import type { ProjectSearchDraft } from './use-project-search';
import { useProjectSearch, useProjectSearchDraft } from './use-project-search';

/**
 * DOM id of one result row. A match key carries a path, so it can hold anything a filename can, including the ASCII
 * whitespace an id may not contain. Percent-encoded rather than filtered, because the mapping has to stay injective: a
 * filter that folds every non-ASCII character into one placeholder gives `笔记.md` and `文档.md` the same id, and
 * `aria-activedescendant` then names the wrong row. The lookup escapes the result with `CSS.escape`, so the remaining
 * punctuation needs no further treatment.
 */
function rowElementId(prefix: string, matchKey: string): string {
    return `${prefix}-${encodeURIComponent(matchKey)}`;
}

/**
 * `openSearchMatch` funnels its own failures through `openFile`'s `tryCommand` wrapper, so callers below intentionally
 * discard the returned promise instead of awaiting it.
 */
function discard(promise: Promise<unknown>): void {
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void promise;
}

async function openSearchMatch(
    sessionId: string,
    match: FileSearchMatch,
    shouldOpenToSide: boolean,
): Promise<void> {
    /*
     * `preview: false` where the sidebar used to pass `true`. A preview tab is the one the next single click replaces,
     * which was the right answer while a click in the tree _was_ the preview; here the overlay already shows the file
     * beside the results, so reaching the editor is a deliberate final step and deserves a tab that stays.
     */
    const opened = await openFile(match.path, { preview: false });
    if (!opened) return;
    if (shouldOpenToSide) {
        const paneId = getActivePaneId();
        const tabId = findPaneTabId({ kind: 'file', path: match.path });
        if (paneId && tabId) splitPaneTab(tabId, paneId, 'right');
    }
    if (match.line === undefined || match.column === undefined) return;
    revealEditorMatch(editorModelPath(sessionViewScope(sessionId), match.path), {
        line: match.line,
        column: match.column,
        matchLength: match.matchLength ?? 0,
    });
}

/**
 * Workspace-wide search, as a centered overlay rather than a panel inside the Files view container.
 *
 * It wears the Dialog scrim instead of the picker's transparent one, which is the deliberate exception to the picker
 * rule in DESIGN.md: a picker stays see-through because the user is aiming at the workbench underneath it, while this
 * surface carries its own preview pane and is what the user is reading. Dimming the workbench is then honest about the
 * workbench being inert.
 */
export function ProjectSearchDialog() {
    const isOpen = useDialogStore((state) => state.projectSearchOpen);
    const seedRequest = useDialogStore((state) => state.projectSearchSeedRequest);
    const { t } = useTranslation();
    const draft = useProjectSearchDraft();
    /**
     * Applied during render rather than in an effect so the opening frame already shows the seeded query and scope,
     * instead of painting the previous draft (and firing a search for it) for one frame first.
     */
    const [appliedSeedId, setAppliedSeedId] = useState(seedRequest.id);
    if (seedRequest.id !== appliedSeedId) {
        setAppliedSeedId(seedRequest.id);
        const { include, query } = seedRequest.seed;
        if (query !== undefined) draft.setQuery(query);
        if (include !== undefined) draft.setInclude(include);
    }
    return (
        <Dialog open={isOpen} onOpenChange={setProjectSearchOpen}>
            <PickerDialogContent
                aria-label={t('projectSearch.dialog.title')}
                backdropClassName="bg-overlay backdrop-blur-[2px]"
                className="top-1/2 flex h-[70vh] max-h-[calc(100vh-64px)] w-[70vw] max-w-6xl -translate-y-1/2 flex-col"
            >
                <ProjectSearchDialogBody draft={draft} />
            </PickerDialogContent>
        </Dialog>
    );
}

function ProjectSearchDialogBody({ draft }: { draft: ProjectSearchDraft }) {
    const { t } = useTranslation();
    const rowIdPrefix = useId();
    const resultsId = useId();
    const isOpen = useDialogStore((state) => state.projectSearchOpen);
    const inputElement = useRef<HTMLInputElement>(null);
    const search = useProjectSearch(draft);
    const { displayState, selectable, selected, selectedIndex, selectedKey, sessionId } = search;
    const rowId = (match: FileSearchMatch): string =>
        rowElementId(rowIdPrefix, searchMatchKey(match));

    /**
     * The rows never take focus, so the browser does not scroll them into view for free the way a roving `tabIndex`
     * tree gets for nothing. Keyboard selection has to ask for it explicitly.
     */
    useEffect(() => {
        if (!selectedKey) return;
        document
            .querySelector(`#${CSS.escape(rowElementId(rowIdPrefix, selectedKey))}`)
            ?.scrollIntoView({ block: 'nearest' });
    }, [rowIdPrefix, selectedKey]);

    /**
     * The draft outlives the popup, while the popup unmounts to cancel reads and release its focus boundary. Select the
     * preserved query on every open so the next keystroke replaces it, including reopens during the exit animation.
     */
    useEffect(() => {
        if (!isOpen) return;
        const input = inputElement.current;
        if (!input) return;
        input.focus();
        input.select();
    }, [isOpen]);

    const open = (match: FileSearchMatch, shouldOpenToSide: boolean): void => {
        if (!sessionId) return;
        setProjectSearchOpen(false);
        discard(openSearchMatch(sessionId, match, shouldOpenToSide));
    };
    const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
        if (isImeComposing(event)) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const delta = event.key === 'ArrowDown' ? 1 : -1;
            search.setSelectedIndex(nextSelectionIndex(selectable.length, selectedIndex, delta));
            return;
        }
        if (selected && event.key === 'Enter') {
            event.preventDefault();
            open(selected, event.metaKey);
        }
    };

    return (
        <>
            <DialogTitle className="sr-only">{t('projectSearch.dialog.title')}</DialogTitle>
            <div className="project-search flex min-h-0 flex-1 flex-col">
                <ProjectSearchControls
                    activeDescendantId={selected ? rowId(selected) : undefined}
                    inputElement={inputElement}
                    onInputKeyDown={onInputKeyDown}
                    resultsId={resultsId}
                    search={search}
                />
                <div className="flex min-h-0 flex-1">
                    <div className="flex min-h-0 w-[42%] flex-none flex-col border-r border-border">
                        {displayState === 'results' ? (
                            <ProjectSearchResults
                                groups={search.groups}
                                handlers={{
                                    rowId,
                                    onOpen: (match) => open(match, false),
                                    onSelect: (match) =>
                                        search.setSelectedIndex(
                                            selectable.findIndex(
                                                (candidate) =>
                                                    searchMatchKey(candidate) ===
                                                    searchMatchKey(match),
                                            ),
                                        ),
                                    selectedKey,
                                }}
                                id={resultsId}
                                mode={search.mode}
                                nameTree={search.nameTree}
                            />
                        ) : (
                            <ProjectSearchMessage
                                displayState={displayState}
                                terminationMessage={search.terminationMessage}
                            />
                        )}
                        {displayState === 'results' && search.isTruncated && (
                            <div className="flex-none border-t border-border p-2 text-center text-[11px] text-warning">
                                {search.terminationMessage}
                            </div>
                        )}
                    </div>
                    <ProjectSearchPreview match={selected} sessionId={sessionId ?? ''} />
                </div>
                <div className="flex h-7 flex-none items-center gap-3 border-t border-border px-3 text-[11px] text-muted">
                    <span>{t('projectSearch.dialog.helpMove')}</span>
                    <span>{t('projectSearch.dialog.helpOpen')}</span>
                    <span>{t('projectSearch.dialog.helpOpenToSide')}</span>
                    <span>{t('projectSearch.dialog.helpDoubleClick')}</span>
                </div>
            </div>
        </>
    );
}

function ProjectSearchMessage({
    displayState,
    terminationMessage,
}: {
    displayState: ProjectSearchDisplayState;
    terminationMessage: string | undefined;
}) {
    const { t } = useTranslation();
    switch (displayState) {
        case 'idle':
            return <div className="min-h-0 flex-1" />;
        case 'searching':
            return (
                <div className="p-3 text-center text-muted">
                    {t('projectSearch.status.searching')}
                </div>
            );
        case 'error':
            return (
                <div className="p-3 text-center text-danger" role="alert">
                    {t('projectSearch.status.failed')}
                </div>
            );
        case 'incomplete':
            return (
                <div className="p-3 text-center text-warning" role="status">
                    {terminationMessage}
                </div>
            );
        default:
            return (
                <div className="p-3 text-center text-muted">
                    {t('projectSearch.status.noResults')}
                </div>
            );
    }
}
