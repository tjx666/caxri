import type { WorkbenchRootOption } from '@caxri/protocol';

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
            title: 'Authorize worktree?',
            message: `Allow Caxri to access the folder "${root.rootPath}" for branch "${root.branch}"? Files, Editor, and Git in this Session will switch to this worktree.`,
            confirmLabel: 'Authorize and switch',
        });
        if (!confirmed) return 'canceled';
    }
    const result = await tryCommand(
        root.authorization === 'required'
            ? 'Unable to authorize Workbench Root'
            : 'Unable to switch Workbench Root',
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
