import type { NotificationDelivery } from '@caxri/protocol';

import type { TranslationKey } from '../../i18n';

export interface NotificationHelperPresentation {
    /**
     * The one-sentence state of system notifications, in plain words.
     */
    headlineKey: TranslationKey;
    /**
     * Whether to show the install command with its Copy button.
     */
    isInstallShown: boolean;
    /**
     * What the user loses or keeps in this state; absent when nothing is worth adding.
     */
    noteKey?: TranslationKey;
    tone: 'muted' | 'warning';
}

/**
 * Maps how Main delivers banners to the words the Settings row shows. `basic` and `unavailable` both mean the helper is
 * not installed, so both show the install command; `basic` says banners still appear in a reduced form, `unavailable`
 * says the helper is missing.
 */
export function presentNotificationHelper(
    delivery: NotificationDelivery,
): NotificationHelperPresentation {
    switch (delivery) {
        case 'helper':
            return {
                headlineKey: 'settings.notificationHelper.status.helper',
                isInstallShown: false,
                tone: 'muted',
            };
        case 'native':
            return {
                headlineKey: 'settings.notificationHelper.status.native',
                isInstallShown: false,
                tone: 'muted',
            };
        case 'basic':
            return {
                headlineKey: 'settings.notificationHelper.status.basic',
                isInstallShown: true,
                noteKey: 'settings.notificationHelper.note.basic',
                tone: 'warning',
            };
        case 'unavailable':
            return {
                headlineKey: 'settings.notificationHelper.status.missing',
                isInstallShown: true,
                noteKey: 'settings.notificationHelper.note.unavailable',
                tone: 'warning',
            };
    }
}
