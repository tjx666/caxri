import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { tryCommand } from '../../stores/toasts';

export function openProjectRoot(projectId: string, app: 'finder' | 'editor'): void {
    void tryCommand(translate('primarySidebar.projectRoot.openFailed'), () =>
        caxri.request('project.openRoot', { projectId, application: app }),
    );
}
