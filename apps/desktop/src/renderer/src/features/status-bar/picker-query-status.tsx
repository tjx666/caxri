import { Button } from '../../components/ui/button';
import { CommandEmpty } from '../../components/ui/command';
import { Spinner } from '../../components/ui/spinner';
import { useTranslation } from '../../i18n';

/**
 * Query failures remain actionable even when a picker pins its current selection.
 */
export function PickerQueryStatus({
    noun,
    query,
}: {
    noun: 'branches' | 'worktrees';
    query: {
        isLoading: boolean;
        isError: boolean;
        isFetching: boolean;
        refetch: () => Promise<unknown>;
    };
}) {
    const { t } = useTranslation();
    if (query.isLoading)
        return (
            <div role="status" className="flex items-center gap-2 px-2 py-2 text-muted">
                <Spinner aria-hidden="true" className="size-3" />
                {t(`statusBar.picker.${noun}.loading`)}
            </div>
        );
    if (query.isError)
        return (
            <div
                role="alert"
                className="flex items-center justify-between gap-2 px-2 py-2 text-muted"
            >
                <span>{t(`statusBar.picker.${noun}.loadFailed`)}</span>
                <Button
                    size="sm"
                    variant="secondary"
                    aria-disabled={query.isFetching}
                    aria-busy={query.isFetching}
                    onClick={() => {
                        if (query.isFetching) return;
                        void query.refetch();
                    }}
                >
                    {t('common.retry')}
                </Button>
            </div>
        );
    return <CommandEmpty>{t(`statusBar.picker.${noun}.empty`)}</CommandEmpty>;
}
