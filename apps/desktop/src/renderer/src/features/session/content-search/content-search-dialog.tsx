import { Button } from '../../../components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '../../../components/ui/dialog';
import { Input } from '../../../components/ui/input';
import { setSessionContentSearchOpen, useDialogStore } from '../../../stores/dialogs';
import { openContentSearchResult } from './content-search-commands';
import { contentSearchCoverage } from './content-search-model';
import { useContentSearch } from './use-content-search';

export function ContentSearchDialog() {
    const isOpen = useDialogStore((state) => state.sessionContentSearchOpen);
    return (
        <Dialog open={isOpen} onOpenChange={setSessionContentSearchOpen}>
            <DialogContent className="flex h-[min(680px,calc(100vh-48px))] w-[min(840px,calc(100vw-48px))] flex-col overflow-hidden">
                <ContentSearchDialogBody />
            </DialogContent>
        </Dialog>
    );
}

function ContentSearchDialogBody() {
    const search = useContentSearch();
    return (
        <>
            <DialogHeader>
                <DialogTitle>Search Session Content</DialogTitle>
                <DialogDescription>
                    Search user and assistant messages across active and archived Sessions. Tool
                    output is excluded.
                </DialogDescription>
            </DialogHeader>
            <div className="px-4 pb-3">
                <Input
                    autoFocus
                    aria-label="Search Session Content"
                    maxLength={200}
                    value={search.query}
                    onChange={(event) => search.setQuery(event.target.value)}
                    placeholder="Search conversation text…"
                />
            </div>
            <div
                className="min-h-0 flex-1 overflow-y-auto border-t border-border px-4 py-3"
                aria-busy={search.isLoading}
            >
                {!search.isActive && (
                    <p className="text-muted">Enter text to find a conversation.</p>
                )}
                {search.isLoading && (
                    <p role="status" className="text-muted">
                        Searching Sessions…
                    </p>
                )}
                {search.isError && (
                    <div role="alert" className="flex items-center gap-3">
                        <span>Could not search Session content.</span>
                        <Button variant="secondary" onClick={search.retry}>
                            Retry
                        </Button>
                    </div>
                )}
                {!search.isLoading && search.result && (
                    <>
                        <p role="status" className="mb-3 text-xs text-muted">
                            {contentSearchCoverage(search.result)}
                        </p>
                        {search.result.partial && (
                            <Button variant="secondary" size="sm" onClick={search.retry}>
                                Retry search
                            </Button>
                        )}
                        {search.items.length === 0 && (
                            <p className="py-4 text-muted">
                                {search.result.partial
                                    ? 'No matches in the searched content.'
                                    : 'No matching Sessions.'}
                            </p>
                        )}
                        <ul aria-label="Session content results" className="grid gap-2">
                            {search.items.map((item) => (
                                <li key={item.sessionId}>
                                    <button
                                        type="button"
                                        className="grid w-full gap-1 rounded border border-border px-3 py-2 text-left hover:bg-elevated focus-visible:outline focus-visible:outline-accent"
                                        onClick={() => openContentSearchResult(item.sessionId)}
                                    >
                                        <span className="truncate font-medium">{item.title}</span>
                                        <span className="text-xs text-muted">
                                            {item.project} · {item.provider} ·{' '}
                                            {item.isArchived
                                                ? 'Archived · View in Archived Sessions'
                                                : 'Active · Open Session'}
                                        </span>
                                        <span className="line-clamp-3 text-sm break-words">
                                            {item.snippet}
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </>
                )}
            </div>
        </>
    );
}
