import { useEffect, useRef, useState } from 'react';

import {
    Bell,
    BellOff,
    CheckCheck,
    CircleCheck,
    CircleX,
    Info,
    Settings,
    TriangleAlert,
    X,
} from 'lucide-react';

import { executeCommand } from '../../commands/execute';
import { Button } from '../../components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import type { NotificationEntry } from '../../stores/notifications';
import {
    canMuteNotification,
    notificationTypes,
    useNotificationStore,
} from '../../stores/notifications';
import type { ToastAction } from '../../stores/toast-actions';
import { runToastAction, toastActionLabelKeys } from '../../stores/toast-actions';
import { muteNotification } from '../../stores/toasts';

/**
 * The history's glyph and tone per kind, kept next to the live toast icons in `toast-outlet.tsx` so a notification does
 * not change what it means between the corner it appeared in and the list it is read back from. `warning` carries its
 * semantic color here for the same reason it does live: a degradation that is still in force has to stay legible after
 * the toast expires.
 */
const notificationGlyph = {
    error: { Icon: CircleX, tone: 'text-danger' },
    info: { Icon: Info, tone: 'text-muted' },
    success: { Icon: CircleCheck, tone: 'text-muted' },
    warning: { Icon: TriangleAlert, tone: 'text-warning' },
} as const;

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
    const { t } = useTranslation();
    const muted = useNotificationStore(
        (state) =>
            Boolean(entry.type && state.mutedTypes.includes(entry.type)) &&
            canMuteNotification(entry),
    );
    /**
     * Keyed by the follow-up it answers, not stored bare: a repeat of the same notification keeps this row's identity
     * but replaces its action with the newest occurrence's, and a refusal earned by the old one must not go on hiding a
     * button that would now work.
     */
    const [refused, setRefused] = useState<{ action: ToastAction; reason: string }>();
    const reasonReference = useRef<HTMLParagraphElement>(null);
    const { Icon, tone } = notificationGlyph[entry.kind];
    /**
     * Rendered in the live toast's order: the lesser follow-up first, the primary one last.
     */
    const actions = [entry.secondaryAction, entry.action].filter(
        (item): item is ToastAction => item !== undefined,
    );
    const unavailableReason =
        refused && actions.includes(refused.action) ? refused.reason : undefined;
    /**
     * Whether the follow-up still applies is answered on click, not on render: this list does not re-render when the
     * Session or editor an old entry points at goes away, so a button disabled at render time would be judged against
     * state that has since moved. The reason replaces the buttons in place: the honest alternative to a control that
     * looks live and does nothing.
     */
    const runAction = (action: ToastAction): void => {
        const reason = runToastAction(action);
        if (reason) {
            setRefused({ action, reason });
            return;
        }
        useNotificationStore.getState().setOpen(false);
    };
    /**
     * The button the click started on has just been removed, which would drop focus to the document body and restart
     * keyboard navigation from the top. Moving it to the reason keeps the sequence intact and is also what gets the
     * sentence announced: a live region inserted together with its text is not reliably read.
     */
    useEffect(() => {
        if (unavailableReason) reasonReference.current?.focus();
    }, [unavailableReason]);
    return (
        <li className="flex gap-2 border-b border-border px-3 py-3 last:border-0">
            <Icon size={16} className={cn('mt-0.5 shrink-0', tone)} />
            <div className="min-w-0 flex-1">
                <p className="text-[12px] leading-normal break-words whitespace-pre-wrap">
                    {entry.message}
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted">
                    <span>
                        {entry.projectTitle ??
                            (entry.type ? t(notificationTypes[entry.type].titleKey) : 'Caxri')}
                    </span>
                    <time dateTime={new Date(entry.timestamp).toISOString()}>
                        {entry.timeLabel}
                    </time>
                    {entry.count > 1 && (
                        <span>{t('toasts.center.occurrences', { count: entry.count })}</span>
                    )}
                    {muted && <span>{t('toasts.center.muted')}</span>}
                </div>
                {actions.length > 0 &&
                    (unavailableReason ? (
                        <p
                            ref={reasonReference}
                            tabIndex={-1}
                            className="mt-1 text-[11px] text-muted outline-none"
                            role="status"
                        >
                            {unavailableReason}
                        </p>
                    ) : (
                        <div className="mt-2 flex flex-wrap gap-2">
                            {actions.map((action) => (
                                <Button
                                    key={action.id}
                                    variant="secondary"
                                    size="sm"
                                    aria-label={action.accessibleLabel}
                                    onClick={() => runAction(action)}
                                >
                                    {t(toastActionLabelKeys[action.id])}
                                </Button>
                            ))}
                        </div>
                    ))}
                {canMuteNotification(entry) && !muted && (
                    <Button
                        variant="ghost"
                        size="sm"
                        className="mt-1 text-muted"
                        onClick={() => muteEntry(entry)}
                    >
                        <BellOff size={12} /> {t('toasts.options.mute')}
                    </Button>
                )}
            </div>
            <Tooltip content={t('toasts.center.remove')}>
                <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0 text-muted"
                    aria-label={t('toasts.center.remove')}
                    onClick={() => useNotificationStore.getState().remove(entry.id)}
                >
                    <X size={14} />
                </Button>
            </Tooltip>
        </li>
    );
}

export function NotificationCenter() {
    const { t } = useTranslation();
    const entries = useNotificationStore((state) => state.entries);
    const isOpen = useNotificationStore((state) => state.isOpen);
    const unread = useNotificationStore(
        (state) => state.entries.filter((entry) => entry.unread).length,
    );
    const triggerLabel = unread
        ? t('toasts.center.titleUnread', { count: unread })
        : t('toasts.center.title');
    return (
        <Popover open={isOpen} onOpenChange={useNotificationStore.getState().setOpen}>
            <Tooltip content={triggerLabel}>
                <PopoverTrigger
                    render={
                        <Button
                            variant="ghost"
                            size="sm"
                            className="shrink-0 text-muted"
                            aria-label={triggerLabel}
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
                aria-label={t('toasts.center.title')}
            >
                <div className="flex items-center justify-between border-b border-border px-3 py-2">
                    <h2 className="text-[13px] font-medium">{t('toasts.center.title')}</h2>
                    <div className="flex gap-1">
                        <Tooltip content={t('toasts.center.clearAll')}>
                            <Button
                                variant="ghost"
                                size="icon"
                                disabled={entries.length === 0}
                                aria-label={t('toasts.center.clearAll')}
                                onClick={useNotificationStore.getState().clear}
                            >
                                <CheckCheck size={16} />
                            </Button>
                        </Tooltip>
                        <Tooltip content={t('toasts.center.settings')}>
                            <Button
                                variant="ghost"
                                size="icon"
                                aria-label={t('toasts.center.settings')}
                                onClick={openNotificationSettings}
                            >
                                <Settings size={16} />
                            </Button>
                        </Tooltip>
                        <Tooltip content={t('toasts.center.close')}>
                            <Button
                                variant="ghost"
                                size="icon"
                                aria-label={t('toasts.center.close')}
                                onClick={() => useNotificationStore.getState().setOpen(false)}
                            >
                                <X size={16} />
                            </Button>
                        </Tooltip>
                    </div>
                </div>
                {entries.length === 0 ? (
                    <p className="px-4 py-8 text-center text-[12px] text-muted">
                        {t('toasts.center.empty')}
                    </p>
                ) : (
                    <ul className="max-h-96 overflow-y-auto" aria-label={t('toasts.center.list')}>
                        {entries.map((entry) => (
                            <NotificationRow key={entry.id} entry={entry} />
                        ))}
                    </ul>
                )}
                <p className="border-t border-border px-3 py-2 text-[11px] text-muted">
                    {t('toasts.center.footer')}
                </p>
            </PopoverContent>
        </Popover>
    );
}
