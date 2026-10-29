import { LoadingSkeleton } from '../../components/loading-skeleton';
import { useTranslation } from '../../i18n';
import { useIsSshHost } from '../../stores/environment';
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
    const { t } = useTranslation();
    const isSshHost = useIsSshHost();
    return (
        <div className="flex h-8 items-center gap-3 border-t border-border px-3 text-[11px] text-muted">
            <span>{t('pathBrowser.help.select')}</span>
            {/* A Project-search row names a file in another directory, so completing the input with it would produce a
                path that does not exist. Drop the hint rather than advertise a key that stays inert. */}
            {isCompletable && <span>{t('pathBrowser.help.complete')}</span>}
            <span>{t(isCreateSelected ? 'pathBrowser.help.create' : 'pathBrowser.help.open')}</span>
            <span>{t('pathBrowser.help.parent')}</span>
            {/* Names the shortcut that leaves the anchor where it is, and the one that brings it back. An SSH Host window
                has no free mode to leave for. */}
            {!isSshHost && (
                <span>
                    {t(isProject ? 'pathBrowser.help.anyPath' : 'pathBrowser.help.returnToProject')}
                </span>
            )}
            <span>{t('pathBrowser.help.close')}</span>
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
    const { t } = useTranslation();
    if (isStarting || isNavigating)
        return (
            <LoadingSkeleton
                variant="list"
                className="py-1"
                label={t('pathBrowser.status.loadingFolder')}
            />
        );
    if (displayedError)
        return (
            <p className="p-6 text-center text-danger" role="alert">
                {displayedError.message}
            </p>
        );
    if (!isResultsReady)
        return <p className="p-6 text-center text-muted">{t('pathBrowser.status.searching')}</p>;
    // An empty result is a row inside the list now, beside the group it belongs to and beside the create action, so
    // there is nothing left for this banner to say once results are ready.
    return null;
}
