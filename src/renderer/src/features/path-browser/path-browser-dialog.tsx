import type { KeyboardEvent } from 'react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import type { FileEntry } from '@shared/types';
import { ChevronLeft, CornerDownLeft, FilePlus, FolderPlus } from 'lucide-react';

import { useDebouncedValue } from '@/hooks/use-debounced-value';

import { Dialog, DialogContent, DialogTitle } from '../../components/ui/dialog';
import { Input, InputGroup } from '../../components/ui/input';
import { FileTypeIcon } from '../../icons/files/file-type-icon';
import { cn } from '../../lib/utilities';
import { useCaxriQuery } from '../../queries/client';
import { setPathBrowserOpen, useDialogStore } from '../../stores/dialogs';
import { useSelectedProject, useSelectedSession } from '../../stores/selectors';
import { describeFailure } from '../../stores/toasts';
import { openFile } from '../editor/document-actions';
import { createItem } from '../inspector/panels/files/file-actions';
import {
    completePathQuery,
    filterPathEntries,
    parentDirectoryWithinRoot,
    pathBrowserCreateCandidate,
    pathBrowserEmptyMessage,
} from './path-browser';

const PATH_BROWSER_QUERY_DEBOUNCE_MS = 120;
const EMPTY_ENTRIES: readonly FileEntry[] = [];

function closePathBrowser(): void {
    setPathBrowserOpen(false);
}

function relativeDirectory(root: string, directory: string): string {
    if (directory === root) return '';
    return `${directory.slice(root === '/' ? 1 : root.length + 1)}/`;
}

export function PathBrowserDialog() {
    const isOpen = useDialogStore((state) => state.pathBrowserOpen);
    const project = useSelectedProject();
    const session = useSelectedSession();
    return (
        <Dialog open={isOpen} onOpenChange={setPathBrowserOpen}>
            {isOpen && project && session && (
                <PathBrowserContent
                    key={`${session.id}:${project.rootPath}`}
                    projectTitle={project.displayTitle}
                    root={project.rootPath}
                    sessionId={session.id}
                />
            )}
        </Dialog>
    );
}

function PathBrowserContent({
    projectTitle,
    root,
    sessionId,
}: {
    projectTitle: string;
    root: string;
    sessionId: string;
}) {
    const [nestedDirectory, setNestedDirectory] = useState<string>();
    const [query, setQuery] = useState('');
    const [selectedIndex, setSelectedIndex] = useState(0);
    const debouncedQuery = useDebouncedValue(query, PATH_BROWSER_QUERY_DEBOUNCE_MS);
    const directory = nestedDirectory ?? root;
    const inputReference = useRef<HTMLInputElement>(null);
    const listboxId = useId();
    const { data, error, isError, isFetching, isPending } = useCaxriQuery(
        'files.browse',
        { sessionId, directory, query: debouncedQuery },
        { staleTime: 0 },
    );
    const entries = data?.entries ?? EMPTY_ENTRIES;
    const isTruncated = data?.truncated ?? false;
    const isSettled = query === debouncedQuery && !isPending && !isFetching;
    const matches = useMemo(() => filterPathEntries(entries, query), [entries, query]);
    const emptyMessage = pathBrowserEmptyMessage(matches.length, isTruncated);
    const isExactMatchAvailable = !isTruncated && matches.length === 1 && matches[0].name === query;
    const isResultsReady = isSettled || isExactMatchAvailable;
    const isListboxRendered = isResultsReady && !isError;
    const effectiveSelectedIndex = Math.min(selectedIndex, Math.max(matches.length - 1, 0));
    const selected = isResultsReady ? matches[effectiveSelectedIndex] : undefined;
    const activeOptionId = selected ? `${listboxId}-option-${effectiveSelectedIndex}` : undefined;
    const candidateToCreate = useMemo(
        () => pathBrowserCreateCandidate(query, matches.length, isTruncated),
        [query, matches.length, isTruncated],
    );

    useEffect(() => {
        if (activeOptionId)
            document
                .querySelector(`#${CSS.escape(activeOptionId)}`)
                ?.scrollIntoView({ block: 'nearest' });
    }, [activeOptionId]);
    useEffect(() => inputReference.current?.focus(), []);

    const updateQuery = (value: string): void => {
        setQuery(value);
        setSelectedIndex(0);
    };
    const enterDirectory = (path: string): void => {
        setNestedDirectory(path === root ? undefined : path);
        updateQuery('');
    };
    const goToParent = (): void => {
        const parent = parentDirectoryWithinRoot(root, directory);
        setNestedDirectory(parent === root ? undefined : parent);
        updateQuery('');
    };
    const choose = (entry: FileEntry | undefined): void => {
        if (!entry || entry.kind === 'symlink') return;
        if (entry.kind === 'directory') {
            enterDirectory(entry.path);
            return;
        }
        closePathBrowser();
        // eslint-disable-next-line no-void -- intentional floating-promise discard, openFile() reports its own errors
        void openFile(entry.path);
    };
    /**
     * Reuses the file tree's own create action (`createItem`) instead of a second create path, so this affordance gets
     * the same durable-mutation tracking, toasts, and Project-root containment (the target `directory` is always
     * `nestedDirectory ?? root`, which navigation already keeps within root via `parentDirectoryWithinRoot`/listed
     * entry paths).
     */
    const createFromQuery = async (): Promise<void> => {
        if (!candidateToCreate) return;
        const created = await createItem(
            sessionId,
            directory,
            candidateToCreate.name,
            candidateToCreate.kind,
        );
        if (!created) return;
        if (candidateToCreate.kind === 'directory') {
            enterDirectory(created.path);
            return;
        }
        // `createItem` already opens a newly created file for the selected Session.
        closePathBrowser();
    };
    const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (matches.length === 0) return;
            const delta = event.key === 'ArrowDown' ? 1 : -1;
            setSelectedIndex((current) => (current + delta + matches.length) % matches.length);
            return;
        }
        if (event.key === 'Tab') {
            event.preventDefault();
            const completion = completePathQuery(entries, query, isTruncated);
            if (completion) updateQuery(completion);
            return;
        }
        if (event.key === 'ArrowRight') {
            event.preventDefault();
            if (selected?.kind === 'directory') enterDirectory(selected.path);
            return;
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            if (selected) choose(selected);
            else if (candidateToCreate) {
                // eslint-disable-next-line no-void -- intentional floating-promise discard, createFromQuery() reports its own errors
                void createFromQuery();
            }
            return;
        }
        if (
            event.key === 'ArrowLeft' &&
            (query === '' || (event.currentTarget.selectionStart ?? 1) === 0)
        ) {
            event.preventDefault();
            goToParent();
        }
    };

    return (
        <DialogContent
            className="top-[18%] w-[min(620px,calc(100vw-32px))] translate-y-0 overflow-hidden"
            showCloseButton={false}
        >
            <DialogTitle className="sr-only">Open File by Path</DialogTitle>
            <InputGroup appearance="toolbar" size="palette">
                <button
                    aria-label="Parent directory"
                    className="mr-1 grid size-7 flex-none place-items-center rounded border-0 bg-transparent p-0 text-muted hover:bg-elevated hover:text-foreground disabled:opacity-40"
                    disabled={!root || directory === root}
                    type="button"
                    onClick={goToParent}
                >
                    <ChevronLeft aria-hidden="true" size={16} />
                </button>
                <span className="flex-none text-[12px] text-muted">{projectTitle}/</span>
                <span className="min-w-0 flex-none truncate text-[12px] text-muted">
                    {root ? relativeDirectory(root, directory) : ''}
                </span>
                <Input
                    ref={inputReference}
                    aria-activedescendant={activeOptionId}
                    aria-autocomplete="list"
                    aria-busy={!isResultsReady}
                    aria-controls={isListboxRendered ? listboxId : undefined}
                    aria-expanded={isListboxRendered}
                    aria-label="File path"
                    appearance="embedded"
                    className="min-w-[80px] flex-1 px-1 text-foreground"
                    placeholder="Filter this directory…"
                    role="combobox"
                    size="palette"
                    value={query}
                    onChange={(event) => {
                        const value = event.target.value;
                        if (value === '../') goToParent();
                        else updateQuery(value);
                    }}
                    onKeyDown={handleKeyDown}
                />
            </InputGroup>
            <div className="max-h-[360px] min-h-[180px] overflow-auto p-1">
                {isPending && <p className="p-6 text-center text-muted">Loading…</p>}
                {isError && (
                    <p className="p-6 text-center text-danger" role="alert">
                        {describeFailure(error, 'Unable to read directory')}
                    </p>
                )}
                {!isPending && !isError && !isResultsReady && (
                    <p className="p-6 text-center text-muted">Searching…</p>
                )}
                {isResultsReady && !isError && emptyMessage && !candidateToCreate && (
                    <p className="p-6 text-center text-muted">{emptyMessage}</p>
                )}
                {isResultsReady && !isError && candidateToCreate && (
                    <button
                        type="button"
                        className="path-browser-create flex h-10 w-full cursor-pointer items-center gap-2 rounded border-0 bg-transparent px-2 text-left text-[12px] text-foreground hover:bg-elevated"
                        onClick={() => {
                            // eslint-disable-next-line no-void -- intentional floating-promise discard, createFromQuery() reports its own errors
                            void createFromQuery();
                        }}
                    >
                        {candidateToCreate.kind === 'directory' ? (
                            <FolderPlus aria-hidden="true" className="text-muted" size={14} />
                        ) : (
                            <FilePlus aria-hidden="true" className="text-muted" size={14} />
                        )}
                        <span className="min-w-0 flex-1 truncate">
                            Create {candidateToCreate.kind === 'directory' ? 'folder' : 'file'} “
                            {candidateToCreate.name}”
                        </span>
                    </button>
                )}
                {isListboxRendered && (
                    <div aria-label="Files in current directory" id={listboxId} role="listbox">
                        {matches.map((entry, index) => (
                            <button
                                key={entry.path}
                                id={`${listboxId}-option-${index}`}
                                aria-disabled={entry.kind === 'symlink'}
                                aria-selected={index === effectiveSelectedIndex}
                                className={cn(
                                    'flex h-8 w-full cursor-pointer items-center gap-2 rounded border-0 bg-transparent px-2 text-left text-[12px] text-foreground hover:bg-elevated',
                                    index === effectiveSelectedIndex && 'bg-elevated',
                                    entry.kind === 'symlink' && 'cursor-not-allowed text-muted',
                                )}
                                role="option"
                                type="button"
                                disabled={entry.kind === 'symlink'}
                                onClick={() => choose(entry)}
                                onMouseMove={() => setSelectedIndex(index)}
                            >
                                <FileTypeIcon entry={entry} />
                                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                                {entry.kind === 'directory' && (
                                    <CornerDownLeft
                                        aria-label="Directory"
                                        className="text-muted"
                                        size={13}
                                    />
                                )}
                            </button>
                        ))}
                    </div>
                )}
                {isListboxRendered && isTruncated && matches.length > 0 && (
                    <p className="px-2 py-1 text-[10px] text-muted" role="status">
                        Only part of this directory is shown. Refine or open a narrower folder.
                    </p>
                )}
            </div>
            <div className="flex h-8 items-center gap-3 border-t border-border px-3 text-[10px] text-muted">
                <span>↑↓ Select</span>
                <span>Tab Complete</span>
                <span>{candidateToCreate ? 'Enter Create' : '→/Enter Open'}</span>
                <span>← Parent</span>
                <span>Esc Close</span>
            </div>
        </DialogContent>
    );
}
