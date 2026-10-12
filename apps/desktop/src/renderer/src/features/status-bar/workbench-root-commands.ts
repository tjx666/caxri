import type { WorkbenchRootOption } from '@caxri/protocol';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { tryCommand } from '../../stores/toasts';
import { useWorkbenchStore } from '../../stores/workbench';

/**
 * Discovered paths are display-only; explicit confirmation submits an identity-bound ID to Main.
 */
export async function selectWorkbenchRoot(
    sessionId: string,
    root: WorkbenchRootOption,
): Promise<'selected' | 'canceled' | 'failed'> {
    if (root.authorization === 'required') {
        const confirmed = await caxri.window.showConfirm({
            title: translate('statusBar.workbenchRoot.authorizeTitle'),
            message: translate('statusBar.workbenchRoot.authorizeMessage', {
                path: root.rootPath,
                branch: root.branch,
            }),
            confirmLabel: translate('statusBar.workbenchRoot.authorizeConfirm'),
        });
        if (!confirmed) return 'canceled';
    }
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
