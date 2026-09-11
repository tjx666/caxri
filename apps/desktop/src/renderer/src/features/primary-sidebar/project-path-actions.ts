import { caxri } from '../../lib/caxri';
import { tryCommand } from '../../stores/toasts';

export function openProjectRoot(projectId: string, app: 'finder' | 'editor'): void {
    // eslint-disable-next-line no-void -- tryCommand reports the native operation's failure through a toast
    void tryCommand('Opening the Project folder failed', () =>
        caxri.request('project.openRoot', { projectId, application: app }),
    );
}
