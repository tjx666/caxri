import { LoadingSkeleton } from '../../components/loading-skeleton';
import type { usePathBrowser } from './use-path-browser';

export function PathBrowserHelp({
    isCompletable,
    isCreateSelected,
    isProject,
}: {
    isCompletable: boolean;
    isCreateSelected: boolean;
    isProject: boolean;
}) {
    return (
        <div className="flex h-8 items-center gap-3 border-t border-border px-3 text-[10px] text-muted">
            <span>↑↓ Select</span>
            {/* A Project-search row names a file in another directory, so completing the input with it would produce a
                path that does not exist. Drop the hint rather than advertise a key that stays inert. */}
            {isCompletable && <span>Tab Complete</span>}
            <span>{isCreateSelected ? 'Enter Create' : '→/Enter Open'}</span>
            <span>← at start Parent</span>
            {/* Names the shortcut that leaves the anchor where it is, and the one that brings it back. */}
            <span>{isProject ? '/ or ~ Any path' : './ Project'}</span>
            <span>Esc Close</span>
        </div>
    );
}

export function PathBrowserStatus({
    isStarting,
    isNavigating,
    displayedError,
    isResultsReady,
}: Pick<
    ReturnType<typeof usePathBrowser>,
    'isStarting' | 'isNavigating' | 'displayedError' | 'isResultsReady'
>) {
    if (isStarting || isNavigating)
        return <LoadingSkeleton variant="list" className="py-1" label="Loading folder…" />;
    if (displayedError)
        return (
            <p className="p-6 text-center text-danger" role="alert">
                {displayedError.message}
            </p>
        );
    if (!isResultsReady) return <p className="p-6 text-center text-muted">Searching…</p>;
    // An empty result is a row inside the list now, beside the group it belongs to and beside the create action, so
    // there is nothing left for this banner to say once results are ready.
    return null;
}
