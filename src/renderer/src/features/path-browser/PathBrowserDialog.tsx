import { ChevronLeft, CornerDownLeft } from 'lucide-react';
import { useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react';

import type { FileEntry } from '@shared/types';

import { Dialog, DialogContent, DialogTitle } from '../../components/ui/dialog';
import { FileTypeIcon } from '../../icons/files/FileTypeIcon';
import { cn } from '../../lib/utils';
import { useCaxriQuery } from '../../queries/client';
import { setPathBrowserOpen, useDialogStore } from '../../stores/dialogs';
import { useSelectedProject, useSelectedSession } from '../../stores/selectors';
import { describeFailure } from '../../stores/toasts';
import { openFile } from '../editor/document-actions';
import { completePathQuery, filterPathEntries, parentDirectoryWithinRoot } from './path-browser';

const PATH_BROWSER_QUERY_DEBOUNCE_MS = 120;
const EMPTY_ENTRIES: readonly FileEntry[] = [];

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
    const [directory, setDirectory] = useState(root);
    const [query, setQuery] = useState('');
    const [selectedIndex, setSelectedIndex] = useState(0);
    const debouncedQuery = useDebouncedValue(query);
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
    const exactMatchAvailable = !truncated && matches.length === 1 && matches[0].name === query;
    const resultsReady = settled || exactMatchAvailable;
    const effectiveSelectedIndex = Math.min(selectedIndex, Math.max(matches.length - 1, 0));
    const selected = resultsReady ? matches[effectiveSelectedIndex] : undefined;
    const activeOptionId = selected ? `${listboxId}-option-${effectiveSelectedIndex}` : undefined;

    useEffect(() => {
        if (activeOptionId)
            document.getElementById(activeOptionId)?.scrollIntoView({ block: 'nearest' });
    }, [activeOptionId]);

    const close = (): void => setPathBrowserOpen(false);
    const updateQuery = (value: string): void => {
        setQuery(value);
        setSelectedIndex(0);
    };
    const enterDirectory = (path: string): void => {
        setDirectory(path);
        updateQuery('');
    };
    const goToParent = (): void => {
        setDirectory((current) => parentDirectoryWithinRoot(root, current));
        updateQuery('');
    };
    const choose = (entry: FileEntry | undefined): void => {
        if (!entry || entry.kind === 'symlink') return;
        if (entry.kind === 'directory') {
            enterDirectory(entry.path);
            return;
        }
        close();
        void openFile(entry.path);
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
            choose(selected);
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
            <div className="flex h-11 items-center border-b border-border bg-background px-3">
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
                <input
                    aria-activedescendant={activeOptionId}
                    aria-autocomplete="list"
                    aria-busy={!resultsReady}
                    aria-controls={listboxId}
                    aria-expanded="true"
                    aria-label="File path"
                    autoFocus
                    className="h-full min-w-[80px] flex-1 border-0 bg-transparent px-1 text-[13px] text-foreground outline-none"
                    placeholder="Filter this directory…"
                    role="combobox"
                    value={query}
                    onChange={(event) => {
                        const value = event.target.value;
                        if (value === '../') goToParent();
                        else updateQuery(value);
                    }}
                    onKeyDown={handleKeyDown}
                />
            </div>
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
                {resultsReady && !isError && matches.length === 0 && (
                    <p className="p-6 text-center text-muted">No matching file or folder.</p>
                )}
                {resultsReady && !isError && (
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
                {resultsReady && !isError && truncated && (
                    <p className="px-2 py-1 text-[10px] text-muted" role="status">
                        More items are available. Type to narrow the list.
                    </p>
                )}
            </div>
            <div className="flex h-8 items-center gap-3 border-t border-border px-3 text-[10px] text-muted">
                <span>↑↓ Select</span>
                <span>Tab Complete</span>
                <span>→/Enter Open</span>
                <span>← Parent</span>
                <span>Esc Close</span>
            </div>
        </DialogContent>
    );
}
