import { Linking } from 'react-native';

import { showToast } from '../components/toast-store';
import type { Translate } from '../i18n';
import { translate } from '../i18n';

/**
 * Opens a web link in the system browser and tells the reader when the system refuses it, instead of a tap that
 * silently does nothing. `open` and `report` default to the platform and exist so the failure path is testable.
 */
export const openExternalLink = async (
    url: string,
    {
        open = (target: string) => Linking.openURL(target),
        report = (title: string, message: string) => showToast('error', title, message),
        t = translate,
    }: {
        open?: (target: string) => Promise<unknown>;
        report?: (title: string, message: string) => void;
        t?: Translate;
    } = {},
): Promise<void> => {
    try {
        await open(url);
    } catch {
        report(
            t('components.openLinkFailed.title'),
            t('components.openLinkFailed.message', { url }),
        );
    }
};
