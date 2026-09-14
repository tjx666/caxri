import type { KeyboardEvent } from 'react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import type { MethodResult } from '@caxri/protocol';
import { clamp } from 'es-toolkit';

import { useDebouncedValue } from '@/hooks/use-debounced-value';

import { isDirectoryEntry } from '../../lib/file-entry';
import { setPathBrowserOpen } from '../../stores/dialogs';
import { openExternalEditorDocument } from '../editor/external-editor-documents';
import { createItem } from '../view-containers/resource-explorer/file-actions';
import { activeResourceExplorerClient } from '../view-containers/resource-explorer-catalog-client';
import type { PathBrowserInputState } from './path-browser';
import {
    completePathQuery,
    parsePathBrowserInput,
    pathBrowserCreateCandidate,
    pathBrowserEmptyMessage,
    pathBrowserKeyIntent,
    projectDirectoryPath,
} from './path-browser';
import {
    browsePath,
    closePathBrowserSession,
    navigatePathBrowser,
    openPathBrowserEntry,
    startPathBrowser,
} from './path-browser-client';

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

function isSnapshot(result: PathBrowserNavigationResult): result is PathBrowserSnapshot {
    return 'browserId' in result;
}

export function usePathBrowser(projectRoot: string, sessionId: string, workbenchProjectId: string) {
    const [snapshot, setSnapshot] = useState<PathBrowserSnapshot>();
    const [inputState, setInputState] = useState<PathBrowserInputState>({
        input: '',
        mode: 'project',
    });
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [error, setError] = useState<Error>();
    const [isNavigating, setIsNavigating] = useState(false);
    const [isStarting, setIsStarting] = useState(true);
    const [isFetching, setIsFetching] = useState(false);
    const debouncedInputState = useDebouncedValue(inputState, PATH_BROWSER_QUERY_DEBOUNCE_MS);
    const inputReference = useRef<HTMLInputElement>(null);
    const inputRevision = useRef(0);
    const requestGeneration = useRef(0);
    const completedInputWithoutBrowse = useRef<string | null>(null);
    const listboxId = useId();

    let syntaxError: Error | undefined;
    try {
        parsePathBrowserInput(inputState.input);
    } catch (error_) {
        syntaxError = error_ instanceof Error ? error_ : new Error('Invalid path');
    }

    useEffect(() => {
        let isDisposed = false;
        let browserId: string | undefined;
        const startingInputRevision = inputRevision.current;
        const startBrowser = async (): Promise<void> => {
            try {
                const result = await startPathBrowser({ sessionId });
                browserId = result.browserId;
                if (isDisposed) {
                    runPathBrowserDetached(closePathBrowserSession({ browserId }));
                    return;
                }
                setSnapshot(result);
                if (inputRevision.current === startingInputRevision)
                    setInputState({ input: result.input, mode: result.mode });
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
            if (browserId) runPathBrowserDetached(closePathBrowserSession({ browserId }));
        };
    }, [sessionId]);

    const hasSyntaxError = syntaxError !== undefined;
    useEffect(() => {
        const browserId = snapshot?.browserId;
        const completedInput = completedInputWithoutBrowse.current;
        if (completedInput !== null) {
            if (debouncedInputState.input !== completedInput) return;
            completedInputWithoutBrowse.current = null;
        }
        if (
            !browserId ||
            hasSyntaxError ||
            isNavigating ||
            (snapshot.mode === debouncedInputState.mode &&
                snapshot.input === debouncedInputState.input)
        )
            return;
        const generation = ++requestGeneration.current;
        queueMicrotask(() => {
            if (requestGeneration.current === generation) setIsFetching(true);
        });
        const browse = async (): Promise<void> => {
            try {
                const result = await browsePath({
                    browserId,
                    input: debouncedInputState.input,
                    mode: debouncedInputState.mode,
                });
                if (requestGeneration.current !== generation) return;
                setSnapshot(result);
                setError(undefined);
            } catch (error_) {
                if (requestGeneration.current !== generation) return;
                setError(error_ instanceof Error ? error_ : new Error('Unable to browse files'));
            } finally {
                if (requestGeneration.current === generation) setIsFetching(false);
            }
        };
        runPathBrowserDetached(browse());
    }, [
        debouncedInputState.input,
        debouncedInputState.mode,
        hasSyntaxError,
        isNavigating,
        snapshot?.browserId,
        snapshot?.input,
        snapshot?.mode,
    ]);

    const entries = snapshot?.entries ?? EMPTY_ENTRIES;
    const isTruncated = snapshot?.truncated ?? false;
    const isSnapshotCurrent =
        snapshot?.mode === inputState.mode && snapshot.input === inputState.input;
    const isResultsReady =
        !isStarting && !isNavigating && !isFetching && isSnapshotCurrent && !syntaxError;
    const matches = isResultsReady ? entries : EMPTY_ENTRIES;
    const emptyMessage = pathBrowserEmptyMessage(matches.length, isTruncated);
    const isListboxRendered = isResultsReady && !error;
    const effectiveSelectedIndex = clamp(selectedIndex, Math.max(matches.length - 1, 0));
    const selected = matches.at(effectiveSelectedIndex);
    const activeOptionId = selected ? `${listboxId}-option-${effectiveSelectedIndex}` : undefined;
    const candidateToCreate = useMemo(
        () =>
            snapshot?.canCreate === true
                ? pathBrowserCreateCandidate(
                      inputState.mode,
                      inputState.input,
                      matches.length,
                      isTruncated,
                      isResultsReady,
                  )
                : undefined,
        [
            inputState.input,
            inputState.mode,
            isResultsReady,
            isTruncated,
            matches.length,
            snapshot?.canCreate,
        ],
    );

    useEffect(() => {
        if (activeOptionId)
            document
                .querySelector(`#${CSS.escape(activeOptionId)}`)
                ?.scrollIntoView({ block: 'nearest' });
    }, [activeOptionId]);
    useEffect(() => inputReference.current?.focus(), []);

    const updateInput = (input: string): void => {
        completedInputWithoutBrowse.current = null;
        inputRevision.current += 1;
        setError(undefined);
        setInputState((current) => ({ ...current, input }));
        setSelectedIndex(0);
    };

    const acceptSnapshot = (result: PathBrowserSnapshot): void => {
        setSnapshot(result);
        setInputState({ input: result.input, mode: result.mode });
        setSelectedIndex(0);
        setError(undefined);
    };

    const applySnapshotOperation = async (
        operation: Promise<PathBrowserNavigationResult | PathBrowserSnapshot>,
    ): Promise<void> => {
        const startingInputRevision = inputRevision.current;
        requestGeneration.current += 1;
        setIsNavigating(true);
        setIsFetching(false);
        try {
            const result = await operation;
            if (isSnapshot(result)) {
                if (inputRevision.current === startingInputRevision) acceptSnapshot(result);
                else {
                    setSnapshot(result);
                    setSelectedIndex(0);
                    setError(undefined);
                }
            }
        } catch (error_) {
            setError(error_ instanceof Error ? error_ : new Error('Unable to open path'));
        } finally {
            setIsNavigating(false);
        }
    };

    const detachProject = (): void => {
        if (!snapshot || inputState.mode !== 'project') return;
        runPathBrowserDetached(
            applySnapshotOperation(
                navigatePathBrowser({
                    browserId: snapshot.browserId,
                    target: { kind: 'detachProject' },
                }),
            ),
        );
    };

    const goToParent = (): void => {
        if (!snapshot?.canGoParent) return;
        runPathBrowserDetached(
            applySnapshotOperation(
                navigatePathBrowser({
                    browserId: snapshot.browserId,
                    target: { kind: 'parent' },
                }),
            ),
        );
    };

    const openEntry = async (entry: PathBrowserEntry): Promise<void> => {
        if (!snapshot || (entry.kind === 'symlink' && snapshot.mode === 'free')) return;
        requestGeneration.current += 1;
        setIsNavigating(true);
        setIsFetching(false);
        try {
            const result = await openPathBrowserEntry({
                browserId: snapshot.browserId,
                entryId: entry.id,
            });
            if (result.kind === 'external') {
                const opened = openExternalEditorDocument({
                    document: result.document,
                    sessionId,
                    workbenchProjectId,
                });
                if (!opened) throw new Error('Unable to open external file in this Session');
            }
            closePathBrowser();
        } catch (error_) {
            setError(error_ instanceof Error ? error_ : new Error('Unable to open path'));
        } finally {
            setIsNavigating(false);
        }
    };

    const choose = (entry: PathBrowserEntry | undefined): void => {
        if (!snapshot || !entry || (entry.kind === 'symlink' && snapshot.mode === 'free')) return;
        if (entry.kind === 'symlink' || isDirectoryEntry(entry)) {
            runPathBrowserDetached(
                applySnapshotOperation(
                    navigatePathBrowser({
                        browserId: snapshot.browserId,
                        target: { entryId: entry.id, kind: 'entry' },
                    }),
                ),
            );
            return;
        }
        runPathBrowserDetached(openEntry(entry));
    };

    /**
     * Project-local creation continues through the Files mutation journal; free-path browsing never reaches this
     * action.
     */
    const createFromQuery = async (): Promise<void> => {
        if (!candidateToCreate || !snapshot?.canCreate || inputState.mode !== 'project') return;
        const client = await activeResourceExplorerClient();
        const path = projectDirectoryPath(projectRoot, snapshot.directoryLabel);
        const directory = path === '/' ? path : path.slice(0, -1);
        const created = await createItem(
            client,
            sessionId,
            directory,
            candidateToCreate.name,
            candidateToCreate.kind,
        );
        if (!created) return;
        if (candidateToCreate.kind === 'directory') {
            const listed = await browsePath({
                browserId: snapshot.browserId,
                input: candidateToCreate.name,
                mode: 'project',
            });
            const directory = listed.entries.find(
                (entry) => entry.kind === 'directory' && entry.name === candidateToCreate.name,
            );
            if (!directory) throw new Error('Created folder could not be reopened');
            await applySnapshotOperation(
                navigatePathBrowser({
                    browserId: snapshot.browserId,
                    target: { entryId: directory.id, kind: 'entry' },
                }),
            );
            return;
        }
        closePathBrowser();
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
        const intent = pathBrowserKeyIntent({
            entryCount: matches.length,
            input: inputState.input,
            isComposing: event.nativeEvent.isComposing,
            key: event.key,
            mode: inputState.mode,
            selectedKind: selected && isDirectoryEntry(selected) ? 'directory' : selected?.kind,
            selectionEnd: event.currentTarget.selectionEnd,
            selectionStart: event.currentTarget.selectionStart,
        });
        if (!intent) return;
        event.preventDefault();
        switch (intent.kind) {
            case 'close': {
                closePathBrowser();
                return;
            }
            case 'move-selection': {
                setSelectedIndex(
                    (current) => (current + intent.delta + matches.length) % matches.length,
                );
                return;
            }
            case 'complete': {
                if (syntaxError) return;
                const completion = completePathQuery(matches, inputState.input, isTruncated);
                if (completion) {
                    completedInputWithoutBrowse.current = completion;
                    inputRevision.current += 1;
                    setInputState((current) => ({ ...current, input: completion }));
                    setSelectedIndex(0);
                    /**
                     * Completion is offered only for one authoritative, non-truncated candidate. Keep that opaque
                     * candidate actionable immediately so a fast Tab → Enter sequence does not become a no-op while the
                     * debounced identical filter catches up.
                     */
                    setSnapshot((current) =>
                        current?.mode === inputState.mode
                            ? { ...current, input: completion }
                            : current,
                    );
                }
                return;
            }
            case 'enter-directory': {
                choose(selected);
                return;
            }
            case 'parent': {
                goToParent();
                return;
            }
            case 'detach-project': {
                detachProject();
                return;
            }
            case 'accept': {
                if (syntaxError) {
                    setError(syntaxError);
                    return;
                }
                if (selected) choose(selected);
                else if (candidateToCreate) runPathBrowserDetached(createFromQuery());
            }
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
        goToParent,
        handleKeyDown,
        input: inputState.input,
        inputReference,
        isListboxRendered,
        isNavigating,
        isResultsReady,
        isStarting,
        isTruncated,
        listboxId,
        matches,
        mode: inputState.mode,
        selectIndex: setSelectedIndex,
        snapshot,
        updateInput,
    };
}
