import { FilePlus, FolderPlus } from 'lucide-react';

import { describeFailure } from '../../stores/toasts';
import type { usePathBrowser } from './use-path-browser';
import { runPathBrowserDetached } from './use-path-browser';

export function PathBrowserHelp({
    hasCreationCandidate,
    isProject,
}: {
    hasCreationCandidate: boolean;
    isProject: boolean;
}) {
    return (
        <div className="flex h-8 items-center gap-3 border-t border-border px-3 text-[10px] text-muted">
            <span>↑↓ Select</span>
            <span>Tab Complete</span>
            <span>{hasCreationCandidate ? 'Enter Create' : '→/Enter Open'}</span>
            <span>← at start Parent</span>
            {isProject && <span>⌫ at start Browse anywhere</span>}
            <span>Esc Close</span>
        </div>
    );
}

export function PathBrowserStatus({
    isStarting,
    isNavigating,
    displayedError,
    isResultsReady,
    emptyMessage,
    candidateToCreate,
    createFromQuery,
}: Pick<
    ReturnType<typeof usePathBrowser>,
    | 'isStarting'
    | 'isNavigating'
    | 'displayedError'
    | 'isResultsReady'
    | 'emptyMessage'
    | 'candidateToCreate'
    | 'createFromQuery'
>) {
    if (isStarting || isNavigating) return <p className="p-6 text-center text-muted">Loading…</p>;
    if (displayedError)
        return (
            <p className="p-6 text-center text-danger" role="alert">
                {describeFailure(displayedError, 'Unable to open path')}
            </p>
        );
    if (!isResultsReady) return <p className="p-6 text-center text-muted">Searching…</p>;
    if (candidateToCreate)
        return (
            <button
                type="button"
                className="path-browser-create flex h-10 w-full cursor-pointer items-center gap-2 rounded border-0 bg-transparent px-2 text-left text-[12px] text-foreground hover:bg-elevated"
                onClick={() => runPathBrowserDetached(createFromQuery())}
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
        );
    if (emptyMessage) return <p className="p-6 text-center text-muted">{emptyMessage}</p>;
    return null;
}
