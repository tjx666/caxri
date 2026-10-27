import { errorMessage } from '@caxri/protocol';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { openExternalUrl } from '../../lib/external-link';
import { pushToast, tryCommand } from '../../stores/toasts';

const REPOSITORY_URL = 'https://github.com/tjx666/caxri';

/**
 * The public pages behind the Help menu. Kept as constants so the menu, the palette, and the Welcome view link to one
 * address each.
 */
export const HELP_URLS = {
    documentation: `${REPOSITORY_URL}/blob/main/docs/getting-started.md`,
    releaseNotes: `${REPOSITORY_URL}/releases`,
    reportIssue: `${REPOSITORY_URL}/issues/new/choose`,
} as const;

/**
 * Opens a Help page in the external browser through the same Main-checked route as every other link.
 */
export function openHelpPage(page: keyof typeof HELP_URLS): void {
    void openExternalUrl(HELP_URLS[page], (message) => pushToast('error', message));
}

/**
 * Shows the log folder in Finder. Answered by Desktop Main without Server Core, so it works while the Server is down.
 */
export function revealLogs(): void {
    void tryCommand(translate('core.commands.revealLogsFailed'), () =>
        caxri.request('logs.reveal'),
    );
}

/**
 * Writes a privacy-safe diagnostics bundle through Main's save dialog and offers to reveal it.
 */
export function exportDiagnostics(): void {
    void tryCommand(
        translate('core.commands.diagnosticsExportFailed'),
        async () => {
            const result = await caxri.request('diagnostics.export');
            if (result)
                pushToast(
                    'success',
                    translate('core.commands.diagnosticsExported', { path: result.path }),
                    { persist: true, action: { id: 'diagnostics.revealExport' } },
                );
        },
        {
            recovery: (error) => ({
                id: 'diagnostics.copyFailure',
                params: { text: errorMessage(error, 'Unknown diagnostics export error') },
            }),
        },
    );
}
