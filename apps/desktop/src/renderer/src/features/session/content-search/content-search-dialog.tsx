import { Button } from '../../../components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '../../../components/ui/dialog';
import { Input } from '../../../components/ui/input';
import { useTranslation } from '../../../i18n';
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
    const { t } = useTranslation();
    return (
        <>
            <DialogHeader>
                <DialogTitle>{t('session.contentSearch.title')}</DialogTitle>
                <DialogDescription>{t('session.contentSearch.description')}</DialogDescription>
            </DialogHeader>
            <div className="px-4 pb-3">
                <Input
                    autoFocus
                    aria-label={t('session.contentSearch.title')}
                    maxLength={200}
                    value={search.query}
                    onChange={(event) => search.setQuery(event.target.value)}
                    placeholder={t('session.contentSearch.placeholder')}
                />
            </div>
            <div
                className="min-h-0 flex-1 overflow-y-auto border-t border-border px-4 py-3"
                aria-busy={search.isLoading}
            >
                {!search.isActive && (
                    <p className="text-muted">{t('session.contentSearch.prompt')}</p>
                )}
                {search.isLoading && (
                    <p role="status" className="text-muted">
                        {t('session.contentSearch.searching')}
                    </p>
                )}
                {search.isError && (
                    <div role="alert" className="flex items-center gap-3">
                        <span>{t('session.contentSearch.failed')}</span>
                        <Button variant="secondary" onClick={search.retry}>
                            {t('common.retry')}
                        </Button>
                    </div>
                )}
                {!search.isLoading && search.result && (
                    <>
                        <p role="status" className="mb-3 text-xs text-muted">
                            {contentSearchCoverage(search.result, t)}
                        </p>
                        {search.result.partial && (
                            <Button variant="secondary" size="sm" onClick={search.retry}>
                                {t('session.contentSearch.retrySearch')}
                            </Button>
                        )}
                        {search.items.length === 0 && (
                            <p className="py-4 text-muted">
                                {t(
                                    search.result.partial
                                        ? 'session.contentSearch.noMatchesPartial'
                                        : 'session.contentSearch.noMatches',
                                )}
                            </p>
                        )}
                        <ul aria-label={t('session.contentSearch.results')} className="grid gap-2">
                            {search.items.map((item) => (
                                <li key={item.sessionId}>
                                    <button
                                        type="button"
                                        className="grid w-full gap-1 rounded border border-border px-3 py-2 text-left hover:bg-elevated focus-visible:outline focus-visible:outline-accent"
                                        onClick={() => openContentSearchResult(item.sessionId)}
                                    >
                                        <span className="truncate font-medium">{item.title}</span>
                                        <span className="text-xs text-muted">
                                            {item.project ?? t('session.unknownProject')} ·{' '}
                                            {item.provider} ·{' '}
                                            {t(
                                                item.isArchived
                                                    ? 'session.contentSearch.archivedResult'
                                                    : 'session.contentSearch.activeResult',
                                            )}
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
