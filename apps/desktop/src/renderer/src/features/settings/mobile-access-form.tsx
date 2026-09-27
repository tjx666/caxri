import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';
import { MobileAccessSections } from './mobile-access-sections';
import { useMobileAccessController } from './use-mobile-access-controller';

export function MobileAccessForm() {
    const controller = useMobileAccessController();

    if (!controller.status && controller.loadState === 'error')
        return (
            <div className="grid min-h-16 content-center justify-items-start gap-2" role="alert">
                <p className="m-0 text-[12px] text-danger">{controller.error}</p>
                <Button size="sm" variant="secondary" onClick={controller.reload}>
                    Retry
                </Button>
            </div>
        );

    if (!controller.status)
        return (
            <div className="flex min-h-16 items-center gap-2 text-[12px] text-muted" role="status">
                <Spinner aria-hidden="true" size={13} style={{ width: 13, height: 13 }} />
                Loading mobile access…
            </div>
        );

    return (
        <div className="grid w-full grid-cols-1 gap-4" data-testid="mobile-access-form">
            <MobileAccessSections controller={controller} status={controller.status} />

            {controller.error ? (
                <p className="m-0 text-[11px] text-danger" role="alert">
                    {controller.error}
                </p>
            ) : null}
        </div>
    );
}
