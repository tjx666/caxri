import type { MethodResult } from '@caxri/protocol';

import type { RecentFileMatch } from '../editor/recent-files';
import type {
    PathBrowserCreateCandidate,
    PathBrowserInputState,
    PathBrowserKeyIntent,
    PathBrowserMode,
} from './path-browser';
import { parsePathBrowserInput, pathBrowserCreateCandidate } from './path-browser';
import type { PathBrowserRow } from './path-browser-rows';
import { pathBrowserRows } from './path-browser-rows';

type PathBrowserSnapshot = MethodResult<'pathBrowser.start'>;

const EMPTY_ENTRIES: PathBrowserSnapshot['entries'] = [];

/**
 * True when a browse request would add nothing: the input is unparsable, a navigation already owns the browser, or the
 * current snapshot already answers exactly this input and mode.
 *
 * Takes the snapshot and request fields as primitives so the calling effect can keep listing them individually and stay
 * free of whole-object dependencies.
 */
export function isBrowseRedundant(state: {
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
export function derivePathBrowserView(state: {
    hasSyntaxError: boolean;
    inputState: PathBrowserInputState;
    isFetching: boolean;
    isNavigating: boolean;
    isStarting: boolean;
    /**
     * Recent files for the current filter, or none when the input is not a bare filter in Project mode.
     */
    recentFiles?: readonly RecentFileMatch[];
    snapshot: PathBrowserSnapshot | undefined;
}): {
    candidateToCreate: PathBrowserCreateCandidate | undefined;
    directoryMatches: PathBrowserSnapshot['entries'];
    isResultsReady: boolean;
    isTruncated: boolean;
    rows: PathBrowserRow[];
} {
    const {
        hasSyntaxError,
        inputState,
        isFetching,
        isNavigating,
        isStarting,
        recentFiles,
        snapshot,
    } = state;
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
                  directoryLabel: snapshot.directoryLabel,
                  entries,
                  isDirectoryTruncated: isTruncated,
                  query: parsePathBrowserInput(inputState.input).filter,
                  recent: recentFiles,
                  searchStatus: snapshot.projectSearch,
              })
            : [],
    };
}

/**
 * Dispatches one decoded key intent onto the dialog's actions. Keeping the branch table outside the hook leaves the
 * hook body to state and data flow only.
 */
export function applyPathBrowserIntent(
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

/**
 * Drops the trailing slash of a directory path, keeping the root `/` itself. It is a function rather than an inline
 * conditional because React Compiler cannot lower a conditional inside a try/catch.
 */
export function withoutTrailingSlash(path: string): string {
    return path === '/' ? path : path.slice(0, -1);
}
