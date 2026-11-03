import type { ProjectIcon } from '@caxri/protocol';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { tryCommand } from '../../stores/toasts';
import { refreshWorkbench } from '../../stores/workbench';

/**
 * Saves one icon on every given Project: one, or each machine's checkout under a merged side bar heading.
 */
export async function didSaveProjectIcon(
    projectIds: readonly string[],
    icon: ProjectIcon | null,
): Promise<boolean> {
    const updated = await tryCommand(
        translate('primarySidebar.projectIcon.updateFailed'),
        () =>
            Promise.all(
                projectIds.map((projectId) =>
                    caxri.request('project.setIcon', { projectId, icon }),
                ),
            ),
        { refresh: refreshWorkbench },
    );
    return updated !== undefined;
}
