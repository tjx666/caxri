import type { KeyboardEvent } from 'react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import type { MethodResult } from '@caxri/protocol';
import { clamp } from 'es-toolkit';

import { useDebouncedValue } from '@/hooks/use-debounced-value';

import { caxri } from '../../lib/caxri';
import { setPathBrowserOpen } from '../../stores/dialogs';
import { createItem } from '../view-containers/resource-explorer/file-actions';
import { activeResourceExplorerClient } from '../view-containers/resource-explorer-catalog-client';
import {
    completePathQuery,
    filterPathEntries,
    parsePathBrowserInput,
    pathBrowserCreateCandidate,
    pathBrowserEmptyMessage,
} from './path-browser';

const PATH_BROWSER_QUERY_DEBOUNCE_MS = 120;
const EMPTY_ENTRIES: MethodResult<'pathBrowser.start'>['entries'] = [];

type PathBrowserSnapshot = MethodResult<'pathBrowser.start'>;
export type PathBrowserEntry = PathBrowserSnapshot['entries'][number];
type PathBrowserNavigationResult = MethodResult<'pathBrowser.navigate'>;

function closePathBrowser(): void {
    setPathBrowserOpen(false);
}

async function settleDetached(operation: Promise<unknown>): Promise<void> {
    try {
        await operation;
    } catch {
        // The owning operation reports or intentionally ignores its failure before reaching this boundary.
    }
}

export function runPathBrowserDetached(operation: Promise<unknown>): void {
    // eslint-disable-next-line no-void -- this is the single explicit detached-promise boundary for dialog actions
    void settleDetached(operation);
}

function currentProjectDirectory(root: string, directoryLabel: string): string {
    const relativeDirectory = directoryLabel.replace(/\/$/u, '');
    if (!relativeDirectory) return root;
    return root === '/' ? `/${relativeDirectory}` : `${root}/${relativeDirectory}`;
}

function queryForBrowse(value: string): string | undefined {
    const input = parsePathBrowserInput(value);
    if (input.kind === 'filter') return value;
    if (input.kind === 'relative' && /^[^/]+\/$/u.test(value)) return value.slice(0, -1);
    return undefined;
}

function isSnapshot(result: PathBrowserNavigationResult): result is PathBrowserSnapshot {
    return 'browserId' in result;
}

export function usePathBrowser(projectRoot: string, sessionId: string) {
    const [snapshot, setSnapshot] = useState<PathBrowserSnapshot>();
    const [loadedQuery, setLoadedQuery] = useState('');
    const [query, setQuery] = useState('');
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [error, setError] = useState<Error>();
    const [isNavigating, setIsNavigating] = useState(false);
    const [isStarting, setIsStarting] = useState(true);
    const [isFetching, setIsFetching] = useState(false);
    const debouncedQuery = useDebouncedValue(query, PATH_BROWSER_QUERY_DEBOUNCE_MS);
    const inputReference = useRef<HTMLInputElement>(null);
    const requestGeneration = useRef(0);
    const listboxId = useId();

    let browseQuery: string | undefined;
    let syntaxError: Error | undefined;
    try {
        browseQuery = queryForBrowse(query);
    } catch (error_) {
        syntaxError = error_ instanceof Error ? error_ : new Error('Invalid path');
    }

    useEffect(() => {
        let isDisposed = false;
        let browserId: string | undefined;
        const startBrowser = async (): Promise<void> => {
            try {
                const result = await caxri.request('pathBrowser.start', { sessionId });
                browserId = result.browserId;
                if (isDisposed) {
                    runPathBrowserDetached(caxri.request('pathBrowser.close', { browserId }));
                    return;
                }
                setSnapshot(result);
                setLoadedQuery('');
                setError(undefined);
            } catch (error_) {
                if (!isDisposed)
                    setError(
                        error_ instanceof Error ? error_ : new Error('Unable to browse files'),
                    );
            } finally {
                if (!isDisposed) setIsStarting(false);
            }
        };
        runPathBrowserDetached(startBrowser());
        return () => {
            isDisposed = true;
            requestGeneration.current += 1;
            if (browserId)
                runPathBrowserDetached(caxri.request('pathBrowser.close', { browserId }));
        };
    }, [sessionId]);

    useEffect(() => {
        const browserId = snapshot?.browserId;
        let nextQuery: string | undefined;
        try {
            nextQuery = queryForBrowse(debouncedQuery);
        } catch {
            return;
        }
        if (!browserId || nextQuery === undefined || nextQuery === loadedQuery || isNavigating)
            return;
        const generation = ++requestGeneration.current;
        queueMicrotask(() => {
            if (requestGeneration.current === generation) setIsFetching(true);
        });
        const browse = async (): Promise<void> => {
            try {
                const result = await caxri.request('pathBrowser.browse', {
                    browserId,
                    query: nextQuery,
                });
                if (requestGeneration.current !== generation) return;
                setSnapshot(result);
                setLoadedQuery(nextQuery);
                setError(undefined);
            } catch (error_) {
                if (requestGeneration.current !== generation) return;
                setError(error_ instanceof Error ? error_ : new Error('Unable to browse files'));
            } finally {
                if (requestGeneration.current === generation) setIsFetching(false);
            }
        };
        runPathBrowserDetached(browse());
    }, [debouncedQuery, isNavigating, loadedQuery, snapshot?.browserId]);

    const entries = snapshot?.entries ?? EMPTY_ENTRIES;
    const isTruncated = snapshot?.truncated ?? false;
    const matches = useMemo(
        () => (browseQuery === undefined ? EMPTY_ENTRIES : filterPathEntries(entries, browseQuery)),
        [browseQuery, entries],
    );
    const isResultsReady =
        !isStarting &&
        !isNavigating &&
        (browseQuery === undefined || loadedQuery === browseQuery) &&
        !isFetching;
    const emptyMessage = pathBrowserEmptyMessage(matches.length, isTruncated);
    const isListboxRendered = isResultsReady && !error && browseQuery !== undefined;
    const effectiveSelectedIndex = clamp(selectedIndex, Math.max(matches.length - 1, 0));
    const selected = isResultsReady ? matches[effectiveSelectedIndex] : undefined;
    const activeOptionId = selected ? `${listboxId}-option-${effectiveSelectedIndex}` : undefined;
    const parsedInput = syntaxError ? undefined : parsePathBrowserInput(query);
    const isCreatableQuery =
        snapshot?.canCreate === true &&
        browseQuery !== undefined &&
        (parsedInput?.kind === 'filter' || /^[^/]+\/$/u.test(query));
    const candidateToCreate = useMemo(
        () =>
            isCreatableQuery
                ? pathBrowserCreateCandidate(query, matches.length, isTruncated, isResultsReady)
                : undefined,
        [isCreatableQuery, isResultsReady, isTruncated, matches.length, query],
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

    const applyNavigation = async (
        operation: Promise<PathBrowserNavigationResult>,
    ): Promise<void> => {
        requestGeneration.current += 1;
        setIsNavigating(true);
        setIsFetching(false);
        try {
            const result = await operation;
            if ('opened' in result) {
                closePathBrowser();
                return;
            }
            if ('canceled' in result) return;
            if (isSnapshot(result)) {
                setSnapshot(result);
                setLoadedQuery('');
                setError(undefined);
                updateQuery('');
            }
        } catch (error_) {
            setError(error_ instanceof Error ? error_ : new Error('Unable to open path'));
        } finally {
            setIsNavigating(false);
        }
    };

    const navigateInput = (value: string): void => {
        if (!snapshot) return;
        runPathBrowserDetached(
            applyNavigation(
                caxri.request('pathBrowser.navigate', {
                    browserId: snapshot.browserId,
                    target: { kind: 'input', value },
                }),
            ),
        );
    };

    const goToParent = (): void => {
        if (!snapshot?.canGoParent) return;
        runPathBrowserDetached(
            applyNavigation(
                caxri.request('pathBrowser.navigate', {
                    browserId: snapshot.browserId,
                    target: { kind: 'parent' },
                }),
            ),
        );
    };

    const choose = (entry: PathBrowserEntry | undefined): void => {
        if (!snapshot || !entry || entry.kind === 'symlink') return;
        if (entry.kind === 'directory') {
            runPathBrowserDetached(
                applyNavigation(
                    caxri.request('pathBrowser.navigate', {
                        browserId: snapshot.browserId,
                        target: { kind: 'entry', entryId: entry.id },
                    }),
                ),
            );
            return;
        }
        runPathBrowserDetached(
            applyNavigation(
                caxri.request('pathBrowser.open', {
                    browserId: snapshot.browserId,
                    entryId: entry.id,
                }),
            ),
        );
    };

    /**
     * Project-local creation still goes through the Files mutation journal. Temporary browse contexts never expose a
     * writable directory and set `canCreate` false in Main, so an opaque external grant cannot reach this action.
     */
    const createFromQuery = async (): Promise<void> => {
        if (!candidateToCreate || !snapshot?.canCreate) return;
        const client = await activeResourceExplorerClient();
        const directory = currentProjectDirectory(projectRoot, snapshot.directoryLabel);
        const created = await createItem(
            client,
            sessionId,
            directory,
            candidateToCreate.name,
            candidateToCreate.kind,
        );
        if (!created) return;
        if (candidateToCreate.kind === 'directory') {
            navigateInput(`${candidateToCreate.name}/`);
            return;
        }
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
            if (query.endsWith('/') && selected?.kind === 'directory') {
                choose(selected);
                return;
            }
            if (browseQuery === undefined) {
                if (!syntaxError) navigateInput(query);
                return;
            }
            const completion = completePathQuery(entries, browseQuery, isTruncated);
            if (completion) updateQuery(completion);
            return;
        }
        if (event.key === 'ArrowRight') {
            event.preventDefault();
            if (selected?.kind === 'directory') choose(selected);
            return;
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            if (syntaxError) {
                setError(syntaxError);
                return;
            }
            if (selected) choose(selected);
            else if (candidateToCreate) runPathBrowserDetached(createFromQuery());
            else if (query) navigateInput(query);
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

    return {
        activeOptionId,
        candidateToCreate,
        choose,
        createFromQuery,
        displayedError: syntaxError ?? error,
        effectiveSelectedIndex,
        emptyMessage,
        entries,
        goToParent,
        handleKeyDown,
        inputReference,
        isListboxRendered,
        isNavigating,
        isResultsReady,
        isStarting,
        isTruncated,
        listboxId,
        matches,
        navigateInput,
        pathPrompt: browseQuery === undefined && query && !syntaxError,
        query,
        selectIndex: setSelectedIndex,
        snapshot,
        updateQuery,
    };
}
