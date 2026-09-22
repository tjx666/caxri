import { Button } from '../../components/ui/button';
import { CommandEmpty } from '../../components/ui/command';
import { Spinner } from '../../components/ui/spinner';

/**
 * Query failures remain actionable even when a picker pins its current selection.
 */
export function PickerQueryStatus({
    noun,
    query,
}: {
    noun: string;
    query: {
        isLoading: boolean;
        isError: boolean;
        isFetching: boolean;
        refetch: () => Promise<unknown>;
    };
}) {
    if (query.isLoading)
        return (
            <div role="status" className="flex items-center gap-2 px-2 py-2 text-muted">
                <Spinner aria-hidden="true" className="size-3" />
                Loading {noun}…
            </div>
        );
    if (query.isError)
        return (
            <div
                role="alert"
                className="flex items-center justify-between gap-2 px-2 py-2 text-muted"
            >
                <span>Unable to load {noun}.</span>
                <Button
                    size="sm"
                    variant="secondary"
                    aria-disabled={query.isFetching}
                    aria-busy={query.isFetching}
                    onClick={() => {
                        if (query.isFetching) return;
                        // eslint-disable-next-line no-void -- query refetch reports failures through the inline query state
                        void query.refetch();
                    }}
                >
                    Retry
                </Button>
            </div>
        );
    return <CommandEmpty>No matching {noun}.</CommandEmpty>;
}
