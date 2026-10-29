import { useCallback } from 'react';

import type { MobilePreviewTarget } from '@caxri/protocol';

import { showToast } from '../../components/toast-store';
import { useTranslation } from '../../i18n';
import type { useSessionPreviews } from './use-session-previews';

export type SessionPreviews = ReturnType<typeof useSessionPreviews>;

/**
 * Opens one previewable port in the in-app browser, saying so in a Toast when the computer refused or the server
 * stopped. Shared by the inline chip and the header menu's Open preview rows, so both fail the same way.
 */
export const useOpenPreview = (
    previews: SessionPreviews,
): ((target: MobilePreviewTarget) => Promise<void>) => {
    const { t } = useTranslation();
    const { open } = previews;
    return useCallback(
        async (target) => {
            if (!(await open(target)))
                showToast(
                    'error',
                    t('browser.preview.openFailedTitle'),
                    t('browser.preview.openFailedBody'),
                );
        },
        [open, t],
    );
};
