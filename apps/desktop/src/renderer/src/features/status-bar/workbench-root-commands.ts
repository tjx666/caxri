import type { WorkbenchRootOption } from '@caxri/protocol';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { getBootstrap } from '../../stores/selectors';
import { tryCommand } from '../../stores/toasts';
import { useWorkbenchStore } from '../../stores/workbench';
import { applyFormEdit } from '../settings/config-edit';
import { getSettings, updateSettings } from '../settings/settings-client';

/**
 * Turns `workbench.confirmWorktreeAuthorization` off through `settings.jsonc`, the same path the Settings page writes,
 * so the dialog's checkbox and the Settings switch always show one value. A failed write only costs the next prompt.
 */
async function stopConfirmingAuthorization(): Promise<void> {
    await tryCommand(translate('statusBar.workbenchRoot.dontAskAgainFailed'), async () => {
        const { source } = await getSettings();
        await updateSettings({
            source: applyFormEdit(source, ['workbench.confirmWorktreeAuthorization'], false),
        });
    });
}

/**
 * Asks before authorizing a worktree unless the user turned the question off. Its "Don't ask again" checkbox writes
 * that setting only when the user also confirms.
 */
async function isAuthorizationConfirmed(root: WorkbenchRootOption): Promise<boolean> {
    if (getBootstrap()?.settings['workbench.confirmWorktreeAuthorization'] === false) return true;
    const answer = await caxri.window.showConfirmChoice({
        title: translate('statusBar.workbenchRoot.authorizeTitle'),
        message: translate('statusBar.workbenchRoot.authorizeMessage', {
            path: root.rootPath,
            branch: root.branch,
        }),
        confirmLabel: translate('statusBar.workbenchRoot.authorizeConfirm'),
        dontAskAgainLabel: translate('statusBar.workbenchRoot.authorizeDontAskAgain'),
    });
    if (answer.dontAskAgain) await stopConfirmingAuthorization();
    return answer.isConfirmed;
}

/**
 * Discovered paths are display-only; explicit confirmation submits an identity-bound ID to Main.
 */
export async function selectWorkbenchRoot(
    sessionId: string,
    root: WorkbenchRootOption,
): Promise<'selected' | 'canceled' | 'failed'> {
    if (root.authorization === 'required' && !(await isAuthorizationConfirmed(root)))
        return 'canceled';
    const result = await tryCommand(
        translate(
            root.authorization === 'required'
                ? 'statusBar.workbenchRoot.authorizeFailed'
                : 'statusBar.workbenchRoot.switchFailed',
        ),
        async () => {
            const selected =
                root.authorization === 'required'
                    ? await caxri.request('session.authorizeWorkbenchRoot', {
                          sessionId,
                          worktreeId: root.worktreeId,
                      })
                    : root.projectId
                      ? await caxri.request('session.selectWorkbenchRoot', {
                            sessionId,
                            projectId: root.projectId,
                        })
                      : undefined;
            if (!selected || 'canceled' in selected) return false;
            await useWorkbenchStore.getState().refresh();
            return true;
        },
    );
    return result === true ? 'selected' : 'failed';
}
