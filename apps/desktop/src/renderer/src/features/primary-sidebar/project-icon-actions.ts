import type { ProjectIcon } from '@caxri/protocol';

import { caxri } from '../../lib/caxri';
import { tryCommand } from '../../stores/toasts';
import { refreshWorkbench } from '../../stores/workbench';

export async function didSaveProjectIcon(
    projectId: string,
    icon: ProjectIcon | null,
): Promise<boolean> {
    const updated = await tryCommand(
        'Project icon update failed',
        () => caxri.request('project.setIcon', { projectId, icon }),
        { refresh: refreshWorkbench },
    );
    return updated !== undefined;
}
