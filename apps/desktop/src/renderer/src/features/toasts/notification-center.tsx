import { Bell, BellOff, CheckCheck, CircleCheck, CircleX, Info, Settings, X } from 'lucide-react';

import { executeCommand } from '../../commands/execute';
import { Button } from '../../components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { Tooltip } from '../../components/ui/tooltip';
import type { NotificationEntry } from '../../stores/notifications';
import {
    canMuteNotification,
    notificationTypes,
    useNotificationStore,
} from '../../stores/notifications';
import { muteNotification } from '../../stores/toasts';

function openNotificationSettings(): void {
    useNotificationStore.getState().setOpen(false);
    executeCommand('settings.openNotifications');
}

function muteEntry(entry: NotificationEntry): void {
    if (!entry.type || !canMuteNotification(entry)) return;
    // eslint-disable-next-line no-void -- muteNotification reports failures through tryCommand
    void muteNotification(entry.type);
}

function NotificationRow({ entry }: { entry: NotificationEntry }) {
    const muted = useNotificationStore(
        (state) =>
            Boolean(entry.type && state.mutedTypes.includes(entry.type)) &&
            canMuteNotification(entry),
    );
    const Icon = entry.kind === 'error' ? CircleX : entry.kind === 'success' ? CircleCheck : Info;
    return (
        <li className="flex gap-2 border-b border-border px-3 py-3 last:border-0">
            <Icon
                size={16}
                className={
                    entry.kind === 'error'
                        ? 'mt-0.5 shrink-0 text-danger'
                        : 'mt-0.5 shrink-0 text-muted'
                }
            />
            <div className="min-w-0 flex-1">
                <p className="text-[12px] leading-normal break-words whitespace-pre-wrap">
                    {entry.message}
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted">
                    <span>
                        {entry.projectTitle ??
                            (entry.type ? notificationTypes[entry.type].title : 'Caxri')}
                    </span>
                    <time dateTime={new Date(entry.timestamp).toISOString()}>
                        {entry.timeLabel}
                    </time>
                    {entry.count > 1 && <span>{entry.count} occurrences</span>}
                    {muted && <span>Muted</span>}
                </div>
                {canMuteNotification(entry) && !muted && (
                    <Button
                        variant="ghost"
                        size="sm"
                        className="mt-1 text-muted"
                        onClick={() => muteEntry(entry)}
                    >
                        <BellOff size={12} /> Don't show this type again
                    </Button>
                )}
            </div>
            <Tooltip content="Remove notification">
                <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0 text-muted"
                    aria-label="Remove notification"
                    onClick={() => useNotificationStore.getState().remove(entry.id)}
                >
                    <X size={14} />
                </Button>
            </Tooltip>
        </li>
    );
}

export function NotificationCenter() {
    const entries = useNotificationStore((state) => state.entries);
    const isOpen = useNotificationStore((state) => state.isOpen);
    const unread = useNotificationStore(
        (state) => state.entries.filter((entry) => entry.unread).length,
    );
    return (
        <Popover open={isOpen} onOpenChange={useNotificationStore.getState().setOpen}>
            <Tooltip content={unread ? `Notifications (${unread} unread)` : 'Notifications'}>
                <PopoverTrigger
                    render={
                        <Button
                            variant="ghost"
                            size="sm"
                            className="shrink-0 text-muted"
                            aria-label={
                                unread ? `Notifications (${unread} unread)` : 'Notifications'
                            }
                        />
                    }
                >
                    <Bell size={14} />
                    {unread > 0 && <span className="text-[11px]">{unread}</span>}
                </PopoverTrigger>
            </Tooltip>
            <PopoverContent
                side="top"
                align="end"
                className="flex w-96 max-w-full flex-col"
                aria-label="Notifications"
            >
                <div className="flex items-center justify-between border-b border-border px-3 py-2">
                    <h2 className="text-[13px] font-medium">Notifications</h2>
                    <div className="flex gap-1">
                        <Tooltip content="Clear all notifications">
                            <Button
                                variant="ghost"
                                size="icon"
                                disabled={entries.length === 0}
                                aria-label="Clear all notifications"
                                onClick={useNotificationStore.getState().clear}
                            >
                                <CheckCheck size={16} />
                            </Button>
                        </Tooltip>
                        <Tooltip content="Notification settings">
                            <Button
                                variant="ghost"
                                size="icon"
                                aria-label="Notification settings"
                                onClick={openNotificationSettings}
                            >
                                <Settings size={16} />
                            </Button>
                        </Tooltip>
                        <Tooltip content="Close notifications">
                            <Button
                                variant="ghost"
                                size="icon"
                                aria-label="Close notifications"
                                onClick={() => useNotificationStore.getState().setOpen(false)}
                            >
                                <X size={16} />
                            </Button>
                        </Tooltip>
                    </div>
                </div>
                {entries.length === 0 ? (
                    <p className="px-4 py-8 text-center text-[12px] text-muted">
                        No recent notifications
                    </p>
                ) : (
                    <ul className="max-h-96 overflow-y-auto" aria-label="Recent notifications">
                        {entries.map((entry) => (
                            <NotificationRow key={entry.id} entry={entry} />
                        ))}
                    </ul>
                )}
                <p className="border-t border-border px-3 py-2 text-[11px] text-muted">
                    Recent activity from this window. Cleared when the window reloads.
                </p>
            </PopoverContent>
        </Popover>
    );
}
