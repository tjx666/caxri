import { RefreshCw } from 'lucide-react';

import { PanelHeader } from '../../../components/panel-header';
import { Button } from '../../../components/ui/button';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { cn } from '../../../lib/utilities';

export function ExtensionTreeHeader({
    disabled = false,
    isRefreshing,
    onRefresh,
    title,
}: {
    disabled?: boolean;
    isRefreshing: boolean;
    onRefresh?: () => void;
    title: string;
}) {
    const { t } = useTranslation();
    const refreshLabel = t('viewContainers.extensionTree.refresh', { title });
    const isUnavailable = disabled || isRefreshing;
    return (
        <PanelHeader
            title={title}
            actions={
                onRefresh && (
                    <Tooltip content={refreshLabel}>
                        <Button
                            aria-busy={isRefreshing || undefined}
                            aria-disabled={isUnavailable || undefined}
                            aria-label={refreshLabel}
                            className={cn(isUnavailable && 'cursor-not-allowed opacity-45')}
                            size="icon"
                            variant="ghost"
                            onClick={isUnavailable ? undefined : onRefresh}
                        >
                            <RefreshCw
                                aria-hidden="true"
                                className={cn(isRefreshing && 'motion-safe:animate-spin')}
                                size={14}
                            />
                        </Button>
                    </Tooltip>
                )
            }
        />
    );
}
