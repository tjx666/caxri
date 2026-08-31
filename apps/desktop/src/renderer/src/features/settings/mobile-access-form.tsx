import { RefreshCw } from 'lucide-react';

import { MobileAccessSections } from './mobile-access-sections';
import { useMobileAccessController } from './use-mobile-access-controller';

export function MobileAccessForm() {
    const controller = useMobileAccessController();

    if (!controller.status)
        return (
            <div className="flex min-h-16 items-center gap-2 text-[12px] text-muted" role="status">
                <RefreshCw aria-hidden="true" className="animate-spin" size={13} />
                Loading mobile access…
            </div>
        );

    return (
        <div className="grid w-full gap-4" data-testid="mobile-access-form">
            <MobileAccessSections controller={controller} status={controller.status} />

            {controller.error ? (
                <p className="m-0 text-[11px] text-danger" role="alert">
                    {controller.error}
                </p>
            ) : null}
        </div>
    );
}
