import type { KeyboardEvent } from 'react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import type { MethodResult } from '@caxri/protocol';
import { clamp } from 'es-toolkit';

import { useDebouncedValue } from '@/hooks/use-debounced-value';

import { translate, useTranslation } from '../../i18n';
import { isDirectoryEntry } from '../../lib/file-entry';
import { isImeComposing } from '../../lib/ime';
import { setPathBrowserOpen } from '../../stores/dialogs';
import { isRemote } from '../../stores/environment';
import { describeFailure } from '../../stores/toasts';
import { openExternalEditorDocument } from '../editor/external-editor-documents';
import { createItem } from '../view-containers/resource-explorer/file-actions';
import { activeResourceExplorerClient } from '../view-containers/resource-explorer-catalog-client';
import type {
    PathBrowserCreateCandidate,
    PathBrowserInputState,
    PathBrowserKeyIntent,
    PathBrowserMode,
} from './path-browser';
import {
    completePathQuery,
    parsePathBrowserInput,
    pathBrowserCreateCandidate,
    PathBrowserInputError,
    pathBrowserInputTransition,
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
import type { PathBrowserEntry, PathBrowserRow } from './path-browser-rows';
import {
    firstSelectablePathBrowserIndex,
    isSelectablePathBrowserRow,
    nextSelectablePathBrowserIndex,
    pathBrowserRows,
} from './path-browser-rows';

const PATH_BROWSER_QUERY_DEBOUNCE_MS = 120;
const EMPTY_ENTRIES: MethodResult<'pathBrowser.start'>['entries'] = [];

type PathBrowserSnapshot = MethodResult<'pathBrowser.start'>;

export type { PathBrowserEntry, PathBrowserRow } from './path-browser-rows';

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

function toBrowserError(value: unknown, fallback: string): Error {
    return new Error(describeFailure(value, fallback));
}

/**
 * True when a browse request would add nothing: the input is unparsable, a navigation already owns the browser, or the
 * current snapshot already answers exactly this input and mode.
 *
 * Takes the snapshot and request fields as primitives so the calling effect can keep listing them individually and stay
 * free of whole-object dependencies.
 */
function isBrowseRedundant(state: {
    hasSyntaxError: boolean;
    isNavigating: boolean;
    requestedInput: string;
    requestedMode: PathBrowserMode;
    snapshotInput: string | undefined;
    snapshotMode: PathBrowserMode | undefined;
}): boolean {
    if (state.hasSyntaxError || state.isNavigating) return true;
    return (
        state.snapshotMode === state.requestedMode && state.snapshotInput === state.requestedInput
    );
}

/**
 * Projects one snapshot plus the in-flight flags into everything the dialog renders.
 *
 * Results are shown only while the snapshot answers the current input, so a stale list never appears actionable.
 * Creation is decided against the current directory alone: `projectSearch` rows name files elsewhere, so finding a
 * same-named file in another folder must not silently remove the user's ability to create one here.
 */
function derivePathBrowserView(state: {
    hasSyntaxError: boolean;
    inputState: PathBrowserInputState;
    isFetching: boolean;
    isNavigating: boolean;
    isStarting: boolean;
    snapshot: PathBrowserSnapshot | undefined;
}): {
    candidateToCreate: PathBrowserCreateCandidate | undefined;
    directoryMatches: PathBrowserSnapshot['entries'];
    isResultsReady: boolean;
    isTruncated: boolean;
    rows: PathBrowserRow[];
} {
    const { hasSyntaxError, inputState, isFetching, isNavigating, isStarting, snapshot } = state;
    const isSnapshotCurrent =
        snapshot?.mode === inputState.mode && snapshot.input === inputState.input;
    const isResultsReady =
        !isStarting && !isNavigating && !isFetching && isSnapshotCurrent && !hasSyntaxError;
    const entries = isResultsReady ? snapshot.entries : EMPTY_ENTRIES;
    const directoryMatches = entries.filter((entry) => entry.source === 'directory');
    const isTruncated = snapshot?.truncated ?? false;
    const candidateToCreate =
        snapshot?.canCreate === true
            ? pathBrowserCreateCandidate(
                  inputState.mode,
                  inputState.input,
                  directoryMatches.length,
                  isTruncated,
                  isResultsReady,
              )
            : undefined;
    return {
        candidateToCreate,
        directoryMatches,
        isResultsReady,
        isTruncated,
        rows: isResultsReady
            ? pathBrowserRows({
                  candidateToCreate,
                  entries,
                  isDirectoryTruncated: isTruncated,
                  query: parsePathBrowserInput(inputState.input).filter,
                  searchStatus: snapshot.projectSearch,
              })
            : [],
    };
}

/**
 * Dispatches one decoded key intent onto the dialog's actions. Keeping the branch table outside the hook leaves the
 * hook body to state and data flow only.
 */
function applyPathBrowserIntent(
    intent: PathBrowserKeyIntent,
    actions: {
        accept: () => void;
        close: () => void;
        complete: () => void;
        detachProject: () => void;
        enterDirectory: () => void;
        moveSelection: (delta: -1 | 1) => void;
        parent: () => void;
    },
): void {
    switch (intent.kind) {
        case 'accept': {
            actions.accept();
            return;
        }
        case 'close': {
            actions.close();
            return;
        }
        case 'complete': {
            actions.complete();
            return;
        }
        case 'detach-project': {
            actions.detachProject();
            return;
        }
        case 'enter-directory': {
            actions.enterDirectory();
            return;
        }
        case 'move-selection': {
            actions.moveSelection(intent.delta);
            return;
        }
        case 'parent': {
            actions.parent();
        }
    }
}

export function usePathBrowser(projectRoot: string, sessionId: string, workbenchProjectId: string) {
    const { t } = useTranslation();
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
        syntaxError =
            error_ instanceof PathBrowserInputError
                ? new Error(t(error_.messageKey))
                : error_ instanceof Error
                  ? error_
                  : new Error(t('pathBrowser.errors.invalidPath'));
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
                    setError(toBrowserError(error_, translate('pathBrowser.errors.browseFailed')));
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
            isBrowseRedundant({
                hasSyntaxError,
                isNavigating,
                requestedInput: debouncedInputState.input,
                requestedMode: debouncedInputState.mode,
                snapshotInput: snapshot.input,
                snapshotMode: snapshot.mode,
            })
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
                setError(toBrowserError(error_, translate('pathBrowser.errors.browseFailed')));
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

    const { candidateToCreate, directoryMatches, isResultsReady, isTruncated, rows } = useMemo(
        () =>
            derivePathBrowserView({
                hasSyntaxError,
                inputState,
                isFetching,
                isNavigating,
                isStarting,
                snapshot,
            }),
        [hasSyntaxError, inputState, isFetching, isNavigating, isStarting, snapshot],
    );
    const isListboxRendered = isResultsReady && !error;
    /**
     * Headings and notices sit between the rows, so a clamped index can land on one. Falling forward to the first
     * selectable row keeps Enter meaningful and keeps the footer hint describing what is actually highlighted.
     */
    const clampedIndex = clamp(selectedIndex, Math.max(rows.length - 1, 0));
    const clampedRow = rows.at(clampedIndex);
    const effectiveSelectedIndex =
        clampedRow && isSelectablePathBrowserRow(clampedRow)
            ? clampedIndex
            : firstSelectablePathBrowserIndex(rows);
    const selectedRow = rows.at(effectiveSelectedIndex);
    const selected = selectedRow?.kind === 'entry' ? selectedRow.entry : undefined;
    const activeOptionId = selectedRow
        ? `${listboxId}-option-${effectiveSelectedIndex}`
        : undefined;

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
        setInputState((current) => pathBrowserInputTransition(current, input, !isRemote()));
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
            setError(toBrowserError(error_, translate('pathBrowser.errors.openFailed')));
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
                if (!opened) throw new Error(translate('pathBrowser.errors.openExternalFailed'));
            }
            closePathBrowser();
        } catch (error_) {
            setError(toBrowserError(error_, translate('pathBrowser.errors.openFailed')));
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
        if (isNavigating) return;
        setIsNavigating(true);
        setError(undefined);
        try {
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
                if (!directory) throw new Error(translate('pathBrowser.errors.reopenFolderFailed'));
                await applySnapshotOperation(
                    navigatePathBrowser({
                        browserId: snapshot.browserId,
                        target: { entryId: directory.id, kind: 'entry' },
                    }),
                );
                return;
            }
            closePathBrowser();
        } catch (error_) {
            setError(
                toBrowserError(
                    error_,
                    translate(
                        candidateToCreate.kind === 'directory'
                            ? 'pathBrowser.errors.createFolderFailed'
                            : 'pathBrowser.errors.createFileFailed',
                    ),
                ),
            );
        } finally {
            setIsNavigating(false);
        }
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
        const intent = pathBrowserKeyIntent({
            canBrowseFree: !isRemote(),
            entryCount: rows.length,
            input: inputState.input,
            isComposing: isImeComposing(event),
            key: event.key,
            mode: inputState.mode,
            selectedKind: selected && isDirectoryEntry(selected) ? 'directory' : selected?.kind,
            selectionEnd: event.currentTarget.selectionEnd,
            selectionStart: event.currentTarget.selectionStart,
        });
        if (!intent) return;
        event.preventDefault();
        applyPathBrowserIntent(intent, {
            accept: () => {
                if (syntaxError) {
                    setError(syntaxError);
                    return;
                }
                if (!selectedRow) return;
                if (selectedRow.kind === 'create') runPathBrowserDetached(createFromQuery());
                else if (selectedRow.kind === 'entry') choose(selectedRow.entry);
            },
            close: closePathBrowser,
            complete: applyCompletion,
            detachProject,
            enterDirectory: () => choose(selected),
            moveSelection: (delta) =>
                setSelectedIndex((current) =>
                    nextSelectablePathBrowserIndex(
                        rows,
                        clamp(current, Math.max(rows.length - 1, 0)),
                        delta,
                    ),
                ),
            parent: goToParent,
        });
    };

    function applyCompletion(): void {
        if (syntaxError) return;
        const completion = completePathQuery(directoryMatches, inputState.input, isTruncated);
        if (!completion) return;
        completedInputWithoutBrowse.current = completion;
        inputRevision.current += 1;
        setInputState((current) => ({ ...current, input: completion }));
        setSelectedIndex(0);
        /**
         * Completion is offered only for one authoritative, non-truncated candidate. Keep that opaque candidate
         * actionable immediately so a fast Tab → Enter sequence does not become a no-op while the debounced identical
         * filter catches up.
         */
        setSnapshot((current) =>
            current?.mode === inputState.mode ? { ...current, input: completion } : current,
        );
    }

    return {
        activeOptionId,
        choose,
        createFromQuery,
        displayedError: syntaxError ?? error,
        effectiveSelectedIndex,
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
        mode: inputState.mode,
        rows,
        selectedRow,
        selectIndex: setSelectedIndex,
        snapshot,
        updateInput,
    };
}
