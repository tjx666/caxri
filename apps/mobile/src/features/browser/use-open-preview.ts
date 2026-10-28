import { useCallback } from 'react';
import { Alert } from 'react-native';

import type { MobilePreviewTarget } from '@caxri/protocol';

import { useTranslation } from '../../i18n';
import type { useSessionPreviews } from './use-session-previews';

export type SessionPreviews = ReturnType<typeof useSessionPreviews>;

/**
 * Opens one previewable port in the in-app browser, saying so when the computer refused or the server stopped. Shared
 * by the inline chip and the header menu's Open preview rows, so both fail the same way.
 */
export const useOpenPreview = (
    previews: SessionPreviews,
): ((target: MobilePreviewTarget) => Promise<void>) => {
    const { t } = useTranslation();
    const { open } = previews;
    return useCallback(
        async (target) => {
            if (!(await open(target)))
                Alert.alert(
                    t('browser.preview.openFailedTitle'),
                    t('browser.preview.openFailedBody'),
                );
        },
        [open, t],
    );
};
