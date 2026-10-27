import type { ProjectTransferImportResult } from '@caxri/protocol';

import type { TranslationKey } from '../../i18n';
import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { pushToast, tryCommand } from '../../stores/toasts';

/**
 * Skipped folders listed by name in the toast; the rest collapse into a count so a large import stays readable.
 */
const MAX_LISTED_SKIPS = 5;

const skipMessages: Record<
    ProjectTransferImportResult['skipped'][number]['reason'],
    TranslationKey
> = {
    missing: 'core.projectTransfer.skippedMissing',
    exists: 'core.projectTransfer.skippedExists',
    restored: 'core.projectTransfer.restored',
};

/**
 * Saves the user's Projects and unarchived Sessions through Main's save dialog. Dismissing the dialog is silent.
 */
export function exportProjectsAndSessions(): void {
    void tryCommand(translate('core.projectTransfer.exportFailed'), async () => {
        const result = await caxri.request('projectTransfer.export');
        if (result)
            pushToast(
                'success',
                translate('core.projectTransfer.exported', {
                    projects: result.projectCount,
                    sessions: result.sessionCount,
                    path: result.path,
                }),
                { persist: true },
            );
    });
}

/**
 * Imports an export file chosen in Main's open dialog. The Workbench refreshes from the Server's state change; the
 * toast reports what was added and names every Project the import had to skip.
 */
export function importProjectsAndSessions(): void {
    void tryCommand(translate('core.projectTransfer.importFailed'), async () => {
        const result = await caxri.request('projectTransfer.import');
        if (!result) return;
        const notes = [
            ...result.skipped.map(({ rootPath, reason }) =>
                translate(skipMessages[reason], { path: rootPath }),
            ),
            ...result.missingWorkbenchRoots.map((path) =>
                translate('core.projectTransfer.worktreeMissing', { path }),
            ),
        ];
        /**
         * A restored Project is a success the user asked for, not something the import missed, and an import that only
         * restored Projects has no imported count worth reading.
         */
        const isIncomplete =
            result.missingWorkbenchRoots.length > 0 ||
            result.skipped.some(({ reason }) => reason !== 'restored');
        const hasImported = result.projectCount > 0 || result.sessionCount > 0;
        const lines = [
            ...(hasImported || notes.length === 0
                ? [
                      translate('core.projectTransfer.imported', {
                          projects: result.projectCount,
                          sessions: result.sessionCount,
                      }),
                  ]
                : []),
            ...notes.slice(0, MAX_LISTED_SKIPS),
            ...(notes.length > MAX_LISTED_SKIPS
                ? [
                      translate('core.projectTransfer.moreSkipped', {
                          count: notes.length - MAX_LISTED_SKIPS,
                      }),
                  ]
                : []),
        ];
        pushToast(isIncomplete ? 'warning' : 'success', lines.join('\n'), {
            persist: notes.length > 0,
        });
    });
}
