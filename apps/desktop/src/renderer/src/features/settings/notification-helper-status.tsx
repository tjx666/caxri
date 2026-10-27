import { useEffect, useState } from 'react';

import { NOTIFICATION_HELPER_INSTALL_COMMAND } from '@caxri/protocol';

import type { CopyFeedbackStatus } from '../../components/copy-feedback';
import {
    COPY_FEEDBACK_RESET_MS,
    copyButtonLabel,
    writeToClipboardWithFeedback,
} from '../../components/copy-feedback';
import { Button } from '../../components/ui/button';
import { FieldDescription } from '../../components/ui/field';
import { useTranslation } from '../../i18n';
import { textClipboard } from '../../lib/clipboard';
import { caxriQueryKey, queryClient, useCaxriQuery } from '../../queries/client';
import { tryCommand } from '../../stores/toasts';
import {
    openMacosNotificationSettings,
    recheckNotificationHelper,
    sendTestNotification,
} from './notification-helper-client';
import { presentNotificationHelper } from './notification-helper-presentation';

/**
 * How long a status read stays fresh. Coming back to Settings after `brew install` re-reads it, and Check Again skips
 * the wait.
 */
const STATUS_STALE_TIME_MS = 30_000;

/**
 * The live caption and actions under the System notifications row: which backend delivers banners, the install command
 * when the helper is missing, and the Check Again, test, and macOS settings follow-ups.
 */
export function NotificationHelperStatus() {
    const { t } = useTranslation();
    const { data } = useCaxriQuery(
        'notifications.helperStatus',
        {},
        { staleTime: STATUS_STALE_TIME_MS },
    );
    const [isChecking, setIsChecking] = useState(false);
    const [testOutcome, setTestOutcome] = useState<'notSent' | 'sent' | undefined>();
    const [copyStatus, setCopyStatus] = useState<CopyFeedbackStatus>('idle');
    useEffect(() => {
        if (copyStatus === 'idle') return;
        const timer = setTimeout(() => setCopyStatus('idle'), COPY_FEEDBACK_RESET_MS);
        return () => clearTimeout(timer);
    }, [copyStatus]);

    if (!data) return null;
    const presentation = presentNotificationHelper(data.delivery);

    const checkAgain = async (): Promise<void> => {
        if (isChecking) return;
        setIsChecking(true);
        const status = await tryCommand(
            t('settings.notificationHelper.recheck.failed'),
            recheckNotificationHelper,
        );
        if (status)
            queryClient.setQueryData(caxriQueryKey('notifications.helperStatus', {}), status);
        setIsChecking(false);
    };

    const sendTest = async (): Promise<void> => {
        setTestOutcome(undefined);
        const result = await tryCommand(t('settings.notificationHelper.test.failed'), () =>
            sendTestNotification({
                body: t('settings.notificationHelper.test.body'),
                title: t('settings.notificationHelper.test.title'),
            }),
        );
        if (result) setTestOutcome(result.sent ? 'sent' : 'notSent');
    };

    const openMacosSettings = async (): Promise<void> => {
        await tryCommand(
            t('settings.notificationHelper.openMacosSettings.failed'),
            openMacosNotificationSettings,
        );
    };

    return (
        <div className="flex flex-col gap-1.5">
            <FieldDescription role="status" tone={presentation.tone}>
                {t(presentation.headlineKey)}
            </FieldDescription>
            {presentation.isInstallShown ? (
                <div className="flex items-center gap-2">
                    <code className="min-w-0 truncate rounded-md bg-elevated px-2 py-1 font-mono text-[12px] text-foreground select-text">
                        {NOTIFICATION_HELPER_INSTALL_COMMAND}
                    </code>
                    <Button
                        size="sm"
                        variant="secondary"
                        onClick={async () => {
                            // Resolves to a status and never rejects.
                            setCopyStatus(
                                await writeToClipboardWithFeedback(
                                    textClipboard,
                                    NOTIFICATION_HELPER_INSTALL_COMMAND,
                                ),
                            );
                        }}
                    >
                        {copyButtonLabel(
                            copyStatus,
                            t('settings.notificationHelper.copyCommand'),
                            t,
                        )}
                    </Button>
                </div>
            ) : null}
            {presentation.noteKey ? (
                <FieldDescription>{t(presentation.noteKey)}</FieldDescription>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
                <Button
                    aria-disabled={isChecking}
                    size="sm"
                    variant="secondary"
                    onClick={checkAgain}
                >
                    {t(
                        isChecking
                            ? 'settings.notificationHelper.checking'
                            : 'settings.notificationHelper.checkAgain',
                    )}
                </Button>
                <Button size="sm" variant="secondary" onClick={sendTest}>
                    {t('settings.notificationHelper.sendTest')}
                </Button>
                <button
                    type="button"
                    className="cursor-pointer border-0 bg-transparent p-0 text-[11px] text-accent underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline focus-visible:outline-accent"
                    onClick={openMacosSettings}
                >
                    {t('settings.notificationHelper.openMacosSettings')}
                </button>
            </div>
            {testOutcome ? (
                <FieldDescription role="status" tone={testOutcome === 'sent' ? 'muted' : 'warning'}>
                    {t(
                        testOutcome === 'sent'
                            ? 'settings.notificationHelper.test.sent'
                            : 'settings.notificationHelper.test.notSent',
                    )}
                </FieldDescription>
            ) : null}
        </div>
    );
}
