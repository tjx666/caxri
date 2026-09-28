import { RefreshCw } from 'lucide-react';

import { Tooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/utilities';

export function ProcessTitleBar({
    isRefreshing,
    onRefresh,
}: {
    isRefreshing: boolean;
    onRefresh: () => void;
}) {
    return (
        <header className="process-titlebar relative flex items-center justify-center bg-title-bar-active-background px-12 pl-[84px] text-title-bar-active-foreground [-webkit-app-region:drag] window-inactive:bg-title-bar-inactive-background window-inactive:text-title-bar-inactive-foreground">
            <strong className="overflow-hidden text-[12px] text-ellipsis whitespace-nowrap">
                Process Explorer — Caxri
            </strong>
            <Tooltip content="Refresh processes">
                <button
                    type="button"
                    className="absolute right-3 grid size-[26px] cursor-pointer place-items-center rounded border-0 bg-transparent p-0 text-muted [-webkit-app-region:no-drag] not-aria-disabled:hover:bg-elevated not-aria-disabled:hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-foreground aria-disabled:cursor-default aria-disabled:opacity-55"
                    aria-label="Refresh processes"
                    aria-disabled={isRefreshing}
                    aria-busy={isRefreshing}
                    onClick={onRefresh}
                >
                    <RefreshCw
                        className={cn(
                            isRefreshing && 'animate-[process-spin_900ms_linear_infinite]',
                        )}
                        size={15}
                    />
                </button>
            </Tooltip>
        </header>
    );
}
