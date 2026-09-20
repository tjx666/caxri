import type { KeyboardEvent } from 'react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import type { FileSearchMatch, FileSearchMode } from '@caxri/protocol';
import { editorModelPath } from '@desktop-shared/editor-state';
import { useQuery } from '@tanstack/react-query';
import { ListFilter, Search, X } from 'lucide-react';

import { useDebouncedValue } from '@/hooks/use-debounced-value';

import { Dialog, DialogTitle, PickerDialogContent } from '../../components/ui/dialog';
import { Input, InputGroup } from '../../components/ui/input';
import { Spinner } from '../../components/ui/spinner';
import { Tooltip } from '../../components/ui/tooltip';
import { caxri } from '../../lib/caxri';
import { cn } from '../../lib/utilities';
import { setProjectSearchOpen, useDialogStore } from '../../stores/dialogs';
import { useSelectedSession } from '../../stores/selectors';
import { sessionViewScope } from '../../stores/session-view';
import { openFile } from '../editor/document-commands';
import { revealEditorMatch } from '../editor/editor-reveal';
import { findPaneTabId, getActivePaneId, splitPaneTab } from '../workbench/pane-actions';
import { ProjectSearchPreview } from './project-search-preview';
import { projectSearchQueryKey } from './project-search-query';
import { ProjectSearchResults } from './project-search-results';
import {
    nextSelectionIndex,
    searchMatchKey,
    selectableSearchMatches,
} from './project-search-selection';
import {
    projectSearchDisplayState,
    projectSearchTerminationMessage,
} from './project-search-status';
import { buildNameSearchTree, groupSearchMatches } from './project-search-tree';

const searchOptionClassName =
    'grid size-6 shrink-0 place-items-center rounded border-0 bg-transparent p-0 text-muted text-[11px] cursor-pointer hover:bg-elevated hover:text-foreground aria-pressed:bg-elevated aria-pressed:text-foreground';

const NO_MATCHES: FileSearchMatch[] = [];

/**
 * DOM id of one result row. A match key carries a path, so it can hold anything a filename can — including the ASCII
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
    return (
        <Dialog open={isOpen} onOpenChange={setProjectSearchOpen}>
            <PickerDialogContent
                aria-label="Search Files"
                backdropClassName="bg-overlay backdrop-blur-[2px]"
                className="top-1/2 flex h-[70vh] max-h-[calc(100vh-64px)] w-[70vw] max-w-6xl -translate-y-1/2 flex-col"
            >
                <ProjectSearchDialogBody />
            </PickerDialogContent>
        </Dialog>
    );
}

function ProjectSearchDialogBody() {
    const session = useSelectedSession();
    const rowIdPrefix = useId();
    const resultsId = useId();
    const isOpen = useDialogStore((state) => state.projectSearchOpen);
    const inputElement = useRef<HTMLInputElement>(null);
    const [query, setQuery] = useState('');
    const [mode, setMode] = useState<FileSearchMode>('name');
    const [caseSensitive, setCaseSensitive] = useState(false);
    const [wholeWord, setWholeWord] = useState(false);
    const [regex, setRegex] = useState(false);
    const [include, setInclude] = useState('');
    const [exclude, setExclude] = useState('');
    /**
     * The selection is stored beside the result list it indexes into, so a new list resets to its first row during
     * render instead of through an effect that would paint a stale selection for one frame. The user is typing: the row
     * that was selected a keystroke ago usually no longer matches, and holding it would leave the preview showing a
     * file the query no longer finds.
     */
    const [selection, setSelection] = useState<{
        index: number;
        matches: readonly FileSearchMatch[];
    }>({ index: 0, matches: NO_MATCHES });
    const debouncedQuery = useDebouncedValue(query, 150);
    const isActive = query.length > 0;
    const isSettled = query === debouncedQuery;
    const sessionId = session?.id;
    const scopeId = session ? `${session.id}:${session.workbenchProjectId}` : '';
    const searchOptions = useMemo(
        () => ({
            mode,
            query: debouncedQuery || ' ',
            caseSensitive: mode === 'content' && caseSensitive,
            wholeWord: mode === 'content' && wholeWord,
            regex: mode === 'content' && regex,
            include,
            exclude,
        }),
        [caseSensitive, debouncedQuery, exclude, include, mode, regex, wholeWord],
    );
    /**
     * `useQuery` rather than `useCaxriQuery`, because only the raw hook hands `queryFn` the AbortSignal React Query
     * cancels when the key changes. A Project-wide content search is the one read in this app expensive enough that an
     * abandoned one has to stop Server work rather than merely be ignored on arrival — each keystroke abandons one.
     */
    const result = useQuery({
        queryKey: projectSearchQueryKey(scopeId, searchOptions),
        queryFn: ({ signal }) =>
            caxri.requestWithSignal('files.search', signal, {
                sessionId: sessionId!,
                ...searchOptions,
            }),
        enabled: sessionId !== undefined && debouncedQuery.length > 0,
    });
    const matches = result.data?.matches ?? NO_MATCHES;
    const groups = useMemo(() => groupSearchMatches(matches), [matches]);
    const nameTree = useMemo(() => buildNameSearchTree(matches), [matches]);
    const selectable = useMemo(
        () => selectableSearchMatches(mode, groups, nameTree),
        [groups, mode, nameTree],
    );
    const selectedIndex = selection.matches === matches ? selection.index : 0;
    const setSelectedIndex = (index: number): void => setSelection({ index, matches });
    /*
     * `at` rather than an index, because `selectable` is empty before the first search and whenever a query has no hits;
     * `at` types that away as `undefined` instead of lying about it, and on an empty list the clamp lands on -1, which
     * `at` also answers with `undefined`.
     */
    const selected = selectable.at(Math.min(selectedIndex, selectable.length - 1));
    const selectedKey = selected ? searchMatchKey(selected) : undefined;
    const rowId = (match: FileSearchMatch): string =>
        rowElementId(rowIdPrefix, searchMatchKey(match));
    const displayState = projectSearchDisplayState({
        active: isActive,
        settled: isSettled,
        fetching: result.isFetching,
        failed: result.isError,
        matchCount: result.data?.matches.length,
        truncated: result.data?.truncated,
        canceled: result.data?.canceled,
    });
    const terminationMessage = result.data
        ? projectSearchTerminationMessage(
              result.data.terminationReason,
              result.data.scannedFiles,
              result.data.matches.length > 0,
          )
        : undefined;
    const SearchModeIcon = mode === 'name' ? ListFilter : Search;

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
     * The popup stays mounted while the overlay is closed, so the last query, mode, and filters survive a reopen the
     * way VS Code's Search view keeps them. Selecting the text on every open is what makes that a convenience instead
     * of a trap: the next keystroke replaces the old query, while Escape-and-reopen still shows what was searched for.
     * `autoFocus` only fires on the first mount, so the focus call belongs here too.
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
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const delta = event.key === 'ArrowDown' ? 1 : -1;
            setSelectedIndex(nextSelectionIndex(selectable.length, selectedIndex, delta));
            return;
        }
        if (selected && event.key === 'Enter') {
            event.preventDefault();
            open(selected, event.metaKey);
        }
    };

    return (
        <>
            <DialogTitle className="sr-only">Search Files</DialogTitle>
            <div className="project-search flex min-h-0 flex-1 flex-col">
                <div className="search-controls flex flex-none flex-col gap-1.5 border-b border-border p-2">
                    <div className="flex items-center gap-1.5">
                        <InputGroup appearance="workbench" size="dense" className="flex-1">
                            <SearchModeIcon
                                size={14}
                                className="shrink-0 text-muted"
                                data-search-mode-icon={mode}
                            />
                            <Input
                                autoFocus
                                ref={inputElement}
                                appearance="embedded"
                                className="flex-1 text-foreground"
                                role="combobox"
                                aria-label={
                                    mode === 'name'
                                        ? 'Find Project files'
                                        : 'Search Project contents'
                                }
                                aria-autocomplete="list"
                                aria-controls={resultsId}
                                aria-expanded={displayState === 'results'}
                                /*
                                 * The rows are `tabIndex={-1}` and the input never gives up focus, so this attribute is
                                 * the only thing telling assistive technology which result the Up/Down keys are on.
                                 */
                                aria-activedescendant={selected ? rowId(selected) : undefined}
                                placeholder={mode === 'name' ? 'Find files' : 'Search text'}
                                value={query}
                                onChange={(event) => setQuery(event.currentTarget.value)}
                                onKeyDown={onInputKeyDown}
                                size="dense"
                            />
                            {(result.isFetching || (isActive && !isSettled)) && (
                                <Spinner size={13} className="shrink-0 text-muted" />
                            )}
                            {isActive && (
                                <Tooltip content="Clear Search">
                                    <button
                                        type="button"
                                        className={searchOptionClassName}
                                        aria-label="Clear Project search"
                                        onClick={() => setQuery('')}
                                    >
                                        <X size={13} />
                                    </button>
                                </Tooltip>
                            )}
                            {mode === 'content' && (
                                <>
                                    <Tooltip content="Match Case">
                                        <button
                                            type="button"
                                            className={searchOptionClassName}
                                            aria-label="Match Case"
                                            aria-pressed={caseSensitive}
                                            onClick={() => setCaseSensitive((value) => !value)}
                                        >
                                            Aa
                                        </button>
                                    </Tooltip>
                                    <Tooltip content="Match Whole Word">
                                        <button
                                            type="button"
                                            className={searchOptionClassName}
                                            aria-label="Match Whole Word"
                                            aria-pressed={wholeWord}
                                            onClick={() => setWholeWord((value) => !value)}
                                        >
                                            ab
                                        </button>
                                    </Tooltip>
                                    <Tooltip content="Use Regular Expression">
                                        <button
                                            type="button"
                                            className={searchOptionClassName}
                                            aria-label="Use Regular Expression"
                                            aria-pressed={regex}
                                            onClick={() => setRegex((value) => !value)}
                                        >
                                            .*
                                        </button>
                                    </Tooltip>
                                </>
                            )}
                        </InputGroup>
                        <div className="search-mode-segments grid w-44 flex-none grid-cols-2 gap-0.5 rounded-md bg-elevated p-0.5">
                            {(['name', 'content'] as const).map((value) => (
                                <button
                                    key={value}
                                    type="button"
                                    className={cn(
                                        'h-6 cursor-pointer rounded border-0 bg-transparent text-[12px] font-medium text-muted hover:text-foreground',
                                        mode === value && 'bg-surface text-foreground shadow-sm',
                                    )}
                                    aria-pressed={mode === value}
                                    onClick={() => setMode(value)}
                                >
                                    {value === 'name' ? 'Name' : 'Content'}
                                </button>
                            ))}
                        </div>
                    </div>
                    {mode === 'content' && (
                        <div className="grid grid-cols-2 gap-1.5">
                            <label className="flex flex-col gap-1 text-[11px] text-muted">
                                <span>Files to include</span>
                                <Input
                                    appearance="workbench"
                                    className="text-foreground"
                                    placeholder="Files to include (e.g. *.ts, src/**)"
                                    size="dense"
                                    value={include}
                                    onChange={(event) => setInclude(event.currentTarget.value)}
                                />
                            </label>
                            <label className="flex flex-col gap-1 text-[11px] text-muted">
                                <span>Files to exclude</span>
                                <Input
                                    appearance="workbench"
                                    className="text-foreground"
                                    placeholder="Files to exclude (e.g. *.min.js, dist/**)"
                                    size="dense"
                                    value={exclude}
                                    onChange={(event) => setExclude(event.currentTarget.value)}
                                />
                            </label>
                        </div>
                    )}
                </div>
                <div className="flex min-h-0 flex-1">
                    <div className="flex min-h-0 w-[42%] flex-none flex-col border-r border-border">
                        {displayState === 'results' ? (
                            <ProjectSearchResults
                                groups={groups}
                                handlers={{
                                    rowId,
                                    onOpen: (match) => open(match, false),
                                    onSelect: (match) =>
                                        setSelectedIndex(
                                            selectable.findIndex(
                                                (candidate) =>
                                                    searchMatchKey(candidate) ===
                                                    searchMatchKey(match),
                                            ),
                                        ),
                                    selectedKey,
                                }}
                                id={resultsId}
                                mode={mode}
                                nameTree={nameTree}
                            />
                        ) : (
                            <ProjectSearchMessage
                                displayState={displayState}
                                terminationMessage={terminationMessage}
                            />
                        )}
                        {displayState === 'results' && result.data?.truncated && (
                            <div className="flex-none border-t border-border p-2 text-center text-[11px] text-warning">
                                {terminationMessage}
                            </div>
                        )}
                    </div>
                    <ProjectSearchPreview match={selected} sessionId={sessionId ?? ''} />
                </div>
                <div className="flex h-7 flex-none items-center gap-3 border-t border-border px-3 text-[11px] text-muted">
                    <span>↑↓ to move</span>
                    <span>Enter to open</span>
                    <span>⌘Enter to open to the side</span>
                    <span>Double-click a result to open it</span>
                </div>
            </div>
        </>
    );
}

function ProjectSearchMessage({
    displayState,
    terminationMessage,
}: {
    displayState: ReturnType<typeof projectSearchDisplayState>;
    terminationMessage: string | undefined;
}) {
    switch (displayState) {
        case 'idle':
            return <div className="min-h-0 flex-1" />;
        case 'searching':
            return <div className="p-3 text-center text-muted">Searching…</div>;
        case 'error':
            return (
                <div className="p-3 text-center text-danger" role="alert">
                    Search failed.
                </div>
            );
        case 'incomplete':
            return (
                <div className="p-3 text-center text-warning" role="status">
                    {terminationMessage}
                </div>
            );
        default:
            return <div className="p-3 text-center text-muted">No results.</div>;
    }
}
