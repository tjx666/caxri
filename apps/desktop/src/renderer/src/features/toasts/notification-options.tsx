import { Ellipsis } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { Tooltip } from '../../components/ui/tooltip';

export function NotificationOptions({
    onMute,
    onOpenChange,
}: {
    onMute: () => void;
    onOpenChange: (isOpen: boolean) => void;
}) {
    return (
        <Popover onOpenChange={onOpenChange}>
            <Tooltip content="Notification options">
                <PopoverTrigger
                    render={
                        <Button variant="ghost" size="icon" aria-label="Notification options" />
                    }
                >
                    <Ellipsis size={16} />
                </PopoverTrigger>
            </Tooltip>
            <PopoverContent align="end" className="w-64 p-2" side="top">
                <Button variant="ghost" size="sm" className="w-full justify-start" onClick={onMute}>
                    Don't show this type again
                </Button>
                <p className="px-2 pt-1 text-[11px] text-muted">
                    Applies to all Projects. Restore in Settings → Notifications.
                </p>
            </PopoverContent>
        </Popover>
    );
}
