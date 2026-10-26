import { Ellipsis } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { settingCategoryPath } from '../settings/setting-spec-text';

export function NotificationOptions({
    onMute,
    onOpenChange,
}: {
    onMute: () => void;
    onOpenChange: (isOpen: boolean) => void;
}) {
    const { t } = useTranslation();
    return (
        <Popover onOpenChange={onOpenChange}>
            <Tooltip content={t('toasts.options.label')}>
                <PopoverTrigger
                    render={
                        <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t('toasts.options.label')}
                        />
                    }
                >
                    <Ellipsis size={16} />
                </PopoverTrigger>
            </Tooltip>
            <PopoverContent align="end" className="w-64 p-2" side="top">
                <Button variant="ghost" size="sm" className="w-full justify-start" onClick={onMute}>
                    {t('toasts.options.mute')}
                </Button>
                <p className="px-2 pt-1 text-[11px] text-muted">
                    {t('toasts.options.muteHint', {
                        path: settingCategoryPath(t, 'notifications.worktreeFallback'),
                    })}
                </p>
            </PopoverContent>
        </Popover>
    );
}
