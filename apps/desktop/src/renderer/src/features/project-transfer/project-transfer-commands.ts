import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { pushToast, tryCommand } from '../../stores/toasts';

/**
 * Skipped folders listed by name in the toast; the rest collapse into a count so a large import stays readable.
 */
const MAX_LISTED_SKIPS = 5;

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
        const skipped = [
            ...result.skipped.map(({ rootPath, reason }) =>
                translate(
                    reason === 'missing'
                        ? 'core.projectTransfer.skippedMissing'
                        : 'core.projectTransfer.skippedExists',
                    { path: rootPath },
                ),
            ),
            ...result.missingWorkbenchRoots.map((path) =>
                translate('core.projectTransfer.worktreeMissing', { path }),
            ),
        ];
        pushToast(
            skipped.length > 0 ? 'warning' : 'success',
            [
                translate('core.projectTransfer.imported', {
                    projects: result.projectCount,
                    sessions: result.sessionCount,
                }),
                ...skipped.slice(0, MAX_LISTED_SKIPS),
                ...(skipped.length > MAX_LISTED_SKIPS
                    ? [
                          translate('core.projectTransfer.moreSkipped', {
                              count: skipped.length - MAX_LISTED_SKIPS,
                          }),
                      ]
                    : []),
            ].join('\n'),
            { persist: skipped.length > 0 },
        );
    });
}
