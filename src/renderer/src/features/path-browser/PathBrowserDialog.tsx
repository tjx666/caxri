import { ChevronLeft, CornerDownLeft, FilePlus, FolderPlus } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import type { FileEntry } from '@shared/types';

import { Dialog, DialogContent, DialogTitle } from '../../components/ui/dialog';
import { Input, InputGroup } from '../../components/ui/input';
import { FileTypeIcon } from '../../icons/files/FileTypeIcon';
import { cn } from '../../lib/utils';
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

function useDebouncedValue(value: string): string {
    const [debounced, setDebounced] = useState(value);
    useEffect(() => {
        const timer = window.setTimeout(() => setDebounced(value), PATH_BROWSER_QUERY_DEBOUNCE_MS);
        return () => window.clearTimeout(timer);
    }, [value]);
    return debounced;
}

export function PathBrowserDialog() {
    const open = useDialogStore((state) => state.pathBrowserOpen);
    const project = useSelectedProject();
    const session = useSelectedSession();
    return (
        <Dialog open={open} onOpenChange={setPathBrowserOpen}>
            {open && project && session && (
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
    const debouncedQuery = useDebouncedValue(query);
    const directory = nestedDirectory ?? root;
    const inputRef = useRef<HTMLInputElement>(null);
    const listboxId = useId();
    const { data, error, isError, isFetching, isPending } = useCaxriQuery(
        'files.browse',
        { sessionId, directory, query: debouncedQuery },
        { staleTime: 0 },
    );
    const entries = data?.entries ?? EMPTY_ENTRIES;
    const truncated = data?.truncated ?? false;
    const settled = query === debouncedQuery && !isPending && !isFetching;
    const matches = useMemo(() => filterPathEntries(entries, query), [entries, query]);
    const emptyMessage = pathBrowserEmptyMessage(matches.length, truncated);
    const exactMatchAvailable = !truncated && matches.length === 1 && matches[0].name === query;
    const resultsReady = settled || exactMatchAvailable;
    const listboxRendered = resultsReady && !isError;
    const effectiveSelectedIndex = Math.min(selectedIndex, Math.max(matches.length - 1, 0));
    const selected = resultsReady ? matches[effectiveSelectedIndex] : undefined;
    const activeOptionId = selected ? `${listboxId}-option-${effectiveSelectedIndex}` : undefined;
    const createCandidate = useMemo(
        () => pathBrowserCreateCandidate(query, matches.length, truncated),
        [query, matches.length, truncated],
    );

    useEffect(() => {
        if (activeOptionId)
            document.getElementById(activeOptionId)?.scrollIntoView({ block: 'nearest' });
    }, [activeOptionId]);
    useEffect(() => inputRef.current?.focus(), []);

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
        void openFile(entry.path);
    };
    /**
     * Reuses the file tree's own create action (`createItem`) instead of a second create path, so
     * this affordance gets the same durable-mutation tracking, toasts, and Project-root containment
     * (the target `directory` is always `nestedDirectory ?? root`, which navigation already keeps
     * within root via `parentDirectoryWithinRoot`/listed entry paths).
     */
    const createFromQuery = async (): Promise<void> => {
        if (!createCandidate) return;
        const created = await createItem(
            sessionId,
            directory,
            createCandidate.name,
            createCandidate.kind,
        );
        if (!created) return;
        if (createCandidate.kind === 'directory') {
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
            const completion = completePathQuery(entries, query, truncated);
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
            else if (createCandidate) void createFromQuery();
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
                    ref={inputRef}
                    aria-activedescendant={activeOptionId}
                    aria-autocomplete="list"
                    aria-busy={!resultsReady}
                    aria-controls={listboxRendered ? listboxId : undefined}
                    aria-expanded={listboxRendered}
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
                {!isPending && !isError && !resultsReady && (
                    <p className="p-6 text-center text-muted">Searching…</p>
                )}
                {resultsReady && !isError && emptyMessage && !createCandidate && (
                    <p className="p-6 text-center text-muted">{emptyMessage}</p>
                )}
                {resultsReady && !isError && createCandidate && (
                    <button
                        type="button"
                        className="path-browser-create flex h-10 w-full cursor-pointer items-center gap-2 rounded border-0 bg-transparent px-2 text-left text-[12px] text-foreground hover:bg-elevated"
                        onClick={() => void createFromQuery()}
                    >
                        {createCandidate.kind === 'directory' ? (
                            <FolderPlus aria-hidden="true" className="text-muted" size={14} />
                        ) : (
                            <FilePlus aria-hidden="true" className="text-muted" size={14} />
                        )}
                        <span className="min-w-0 flex-1 truncate">
                            Create {createCandidate.kind === 'directory' ? 'folder' : 'file'} “
                            {createCandidate.name}”
                        </span>
                    </button>
                )}
                {listboxRendered && (
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
                {listboxRendered && truncated && matches.length > 0 && (
                    <p className="px-2 py-1 text-[10px] text-muted" role="status">
                        Only part of this directory is shown. Refine or open a narrower folder.
                    </p>
                )}
            </div>
            <div className="flex h-8 items-center gap-3 border-t border-border px-3 text-[10px] text-muted">
                <span>↑↓ Select</span>
                <span>Tab Complete</span>
                <span>{createCandidate ? 'Enter Create' : '→/Enter Open'}</span>
                <span>← Parent</span>
                <span>Esc Close</span>
            </div>
        </DialogContent>
    );
}
